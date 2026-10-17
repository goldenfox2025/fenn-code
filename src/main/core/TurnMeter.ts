import type { AgentEvent, StopReason, TurnUsage } from '../../shared/contract'
import { MIN_STREAM_MS, type GenerationTiming } from '../../shared/usage'

/**
 * Client-observed generation time. Chunks are not individual token timestamps.
 * The time tools run (and approvals they wait for) is left out, so a turn with
 * tool calls still measures the model's own output, not the tools' latency.
 */
export class TurnMeter {
  private first?: number
  private last?: number
  private chunks = 0
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
    let genMs = this.last! - this.first - this.toolMs
    // Output that arrives in one burst (an agent that buffers it) says nothing about speed on its own:
    // time it from the send instead, which counts the model's thinking before the burst.
    if (genMs < MIN_STREAM_MS) genMs = this.last! - this.started - this.toolMs
    if (!reliableTokens || output === undefined || !Number.isSafeInteger(output) || output <= 1) timing.noSpeed = 'output'
    else if (stop !== 'end_turn') timing.noSpeed = 'stopped'
    else if (this.interrupted || this.open.size) timing.noSpeed = 'waited'
    else if (genMs < MIN_STREAM_MS) timing.noSpeed = 'short'
    else {
      timing.streamMs = genMs
      timing.outputTokens = output
      timing.tpotMs = genMs / (output - 1)
    }
    return timing
  }
}
