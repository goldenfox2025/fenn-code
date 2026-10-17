import type { Conversation, Message, ModelUsage, UsageDay, UsageSummary } from '../../shared/model'
import { headline } from '../../shared/usage'
import type { Store } from '../store/Store'

/** The local calendar day of a time, as YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Tokens used per day and per model, across every chat, for the home page. Counted as each
 * reply reports them (new input plus output, as in a reply's usage line). Built once from
 * the saved messages, a chat at a time so the app stays responsive, then kept up as replies end.
 */
export class UsageCalendar {
  private days = new Map<string, UsageDay>()
  private models = new Map<string, ModelUsage>()
  private counted = new Set<string>()
  private building?: Promise<void>

  constructor(private readonly store: Store) {}

  async summary(): Promise<UsageSummary> {
    await this.build()
    return {
      days: [...this.days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      models: [...this.models.values()].sort((a, b) => b.tokens - a.tokens)
    }
  }

  /** A reply ended: count it, once the pass over the chats has started (until then that pass will). */
  add(message: Message | undefined): void {
    if (this.building && message) this.count(message, this.store.conversation(message.conversationId))
  }

  private build(): Promise<void> {
    this.building ??= (async () => {
      for (const c of [...this.store.conversations]) {
        for (const m of this.store.peekMessages(c.id)) this.count(m, c)
        await new Promise((r) => setImmediate(r))
      }
    })()
    return this.building
  }

  private count(m: Message, conv: Conversation | undefined): void {
    if (m.role !== 'assistant' || !m.usage || this.counted.has(m.id)) return
    const tokens = headline(m.usage)
    if (!(tokens > 0)) return
    this.counted.add(m.id)
    const day = dayKey(m.createdAt)
    const d = this.days.get(day) ?? { day, tokens: 0, replies: 0 }
    d.tokens += tokens
    d.replies++
    this.days.set(day, d)
    // Replies from before models were recorded count under the chat's model.
    const model = m.model ?? (conv ? { backendId: conv.backendId, id: conv.modelId, name: conv.models?.find((x) => x.id === conv.modelId)?.name } : undefined)
    if (!model) return
    const key = `${model.backendId}\0${model.id ?? ''}`
    const u = this.models.get(key) ?? { backendId: model.backendId, ...(model.id ? { id: model.id } : {}), tokens: 0, replies: 0 }
    if (model.name) u.name = model.name
    u.tokens += tokens
    u.replies++
    this.models.set(key, u)
  }
}
