import type { AgentEvent, StopReason, TurnUsage } from '../../shared/contract'
import type { GenerationTiming } from '../../shared/usage'

/** Client-observed streaming time. Chunks are not individual token timestamps. */
export class TurnMeter {
  private first?: number
  private last?: number
  private chunks = 0
  private interrupted = false

  constructor(private readonly started: number, private readonly now = () => performance.now()) {}

  observe(event: AgentEvent): void {
    if (event.kind === 'tool.start' || event.kind === 'tool.update' || event.kind === 'notice') this.interrupt()
    if ((event.kind === 'message.delta' || event.kind === 'thought.delta') && event.text.length) {
      const time = this.now()
      this.first ??= time
      this.last = time
      this.chunks++
    }
  }

  interrupt(): void { this.interrupted = true }

  finish(usage: TurnUsage | undefined, stop: StopReason, reliableTokens = true): GenerationTiming | undefined {
    if (this.first === undefined) return undefined
    const timing: GenerationTiming = { firstResponseMs: Math.max(0, this.first - this.started) }
    const output = usage?.output
    if (reliableTokens && stop === 'end_turn' && !this.interrupted && this.chunks > 1 &&
      output !== undefined && Number.isSafeInteger(output) && output > 1 && this.last! > this.first) {
      timing.streamMs = this.last! - this.first
      timing.outputTokens = output
      timing.tpotMs = timing.streamMs / (output - 1)
    }
    return timing
  }
}
