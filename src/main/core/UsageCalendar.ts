import type { Message, UsageDay } from '../../shared/model'
import { headline } from '../../shared/usage'
import type { Store } from '../store/Store'

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Tokens used per day, across every chat, for the home page's heatmap. Counted as each
 * reply reports them (new input plus output, as in a reply's usage line). Built once from
 * the saved messages, a chat at a time so the app stays responsive, then kept up as replies end.
 */
export class UsageCalendar {
  private days?: Map<string, UsageDay>
  private counted = new Set<string>()
  private building?: Promise<void>

  constructor(private readonly store: Store) {}

  async list(): Promise<UsageDay[]> {
    await this.build()
    return [...this.days!.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
  }

  /** A reply ended: count it, once the calendar exists (until then the pass over the chats will). */
  add(message: Message | undefined): void {
    if (this.days && message) this.count(message)
  }

  private build(): Promise<void> {
    this.building ??= (async () => {
      this.days = new Map()
      for (const c of [...this.store.conversations]) {
        for (const m of this.store.peekMessages(c.id)) this.count(m)
        await new Promise((r) => setImmediate(r))
      }
    })()
    return this.building
  }

  private count(m: Message): void {
    if (m.role !== 'assistant' || !m.usage || this.counted.has(m.id)) return
    const tokens = headline(m.usage)
    if (!(tokens > 0)) return
    this.counted.add(m.id)
    const day = dayKey(m.createdAt)
    const entry = this.days!.get(day) ?? { day, tokens: 0, replies: 0 }
    entry.tokens += tokens
    entry.replies++
    this.days!.set(day, entry)
  }
}
