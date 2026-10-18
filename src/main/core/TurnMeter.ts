import type { AgentEvent, StopReason, TurnUsage } from '../../shared/contract'
import { MIN_CHUNKS, MIN_STREAM_MS, type GenerationTiming } from '../../shared/usage'

/**
 * Client-observed generation time. Chunks are not individual token timestamps.
 * The time tools run (and approvals they wait for) is left out, so a turn with
 * tool calls still measures the model's own output, not the tools' latency.
 */
export class TurnMeter {
  private first?: number
  private last?: number
  private chunks = 0
  /** Characters of text (the reply and its thinking) seen, for agents that report no token counts. */
  private chars = 0
  private interrupted = false
  /** Tools running now, by id, with when they started. */
  private open = new Map<string, number>()
  private toolMs = 0

  constructor(private readonly started: number, private readonly now = () => performance.now()) {}

  observe(event: AgentEvent): void {
    const time = this.now()
    if ((event.kind === 'message.delta' || event.kind === 'thought.delta') && event.text.trim()) {
      this.first ??= time
      this.last = time
      this.chunks++
      this.chars += [...event.text].length
    } else if (event.kind === 'tool.start') {
      // The call itself is the model's output; running it is not.
      this.first ??= time
      this.last = time
      if (event.status === 'pending' || event.status === 'running') this.open.set(event.toolId, time)
    } else if (event.kind === 'tool.update' && (event.status === 'completed' || event.status === 'failed')) {
      const since = this.open.get(event.toolId)
      if (since !== undefined) {
        this.toolMs += time - since
        this.open.delete(event.toolId)
      }
    } else if (event.kind === 'notice') this.interrupt()
  }

  /** A wait the meter can't account for (an approval outside any tool, a retry): no speed for this turn. */
  interrupt(): void {
    if (!this.open.size) this.interrupted = true
  }

  finish(usage: TurnUsage | undefined, stop: StopReason, reliableTokens = true): GenerationTiming | undefined {
    if (this.first === undefined) return undefined
    const timing: GenerationTiming = { firstResponseMs: Math.max(0, this.first - this.started) }
    const output = usage?.output
    const tokens = reliableTokens && output !== undefined && Number.isSafeInteger(output) && output > 1
    // Speed is the stream itself, first chunk to last, without the tools' time. The wait before the first
    // chunk is not output: a reply that arrives in a few chunks or all at once (an agent that buffers it)
    // can't be timed, and gets no speed rather than one that is mostly waiting.
    const span = this.last! - this.first - this.toolMs
    const measurable = this.chunks >= MIN_CHUNKS && span >= MIN_STREAM_MS
    if (tokens) timing.outputTokens = output
    if (stop !== 'end_turn') timing.noSpeed = 'stopped'
    else if (this.interrupted || this.open.size) timing.noSpeed = 'waited'
    else if (!tokens && this.chars <= 1) timing.noSpeed = 'output'
    else if (!measurable) timing.noSpeed = 'short'
    else if (tokens) {
      timing.streamMs = span
      timing.tpotMs = span / (output - 1)
    } else {
      // No token count: the text as it streamed, in characters (never turned into tokens).
      timing.streamMs = span
      timing.outputChars = this.chars
    }
    return timing
  }
}
