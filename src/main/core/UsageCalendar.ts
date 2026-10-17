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
  private tally = newTally()
  private building?: Promise<void>

  constructor(private readonly store: Store) {}

  async summary(): Promise<UsageSummary> {
    let tally
    do {
      tally = this.tally
      await this.build()
    } while (tally !== this.tally)
    return {
      days: [...tally.days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      models: [...tally.models.values()].sort((a, b) => b.tokens - a.tokens)
    }
  }

  /** A reply ended: count it, once the pass over the chats has started (until then that pass will). */
  add(message: Message | undefined): void {
    if (this.building && message) count(this.tally, message, this.store.conversation(message.conversationId))
  }

  /** Replies went away (a deleted chat, a regenerated reply): the next summary counts everything again. */
  reset(): void {
    this.tally = newTally()
    this.building = undefined
  }

  private build(): Promise<void> {
    const tally = this.tally
    this.building ??= (async () => {
      for (const c of [...this.store.conversations]) {
        if (tally !== this.tally) return
        for (const m of this.store.peekMessages(c.id)) count(tally, m, c)
        await new Promise((r) => setImmediate(r))
      }
    })()
    return this.building
  }
}

interface Tally {
  days: Map<string, UsageDay>
  models: Map<string, ModelUsage>
  counted: Set<string>
}

const newTally = (): Tally => ({ days: new Map(), models: new Map(), counted: new Set() })

function count(t: Tally, m: Message, conv: Conversation | undefined): void {
  if (m.role !== 'assistant' || !m.usage || t.counted.has(m.id)) return
  const tokens = headline(m.usage)
  if (!(tokens > 0)) return
  t.counted.add(m.id)
  const day = dayKey(m.createdAt)
  const d = t.days.get(day) ?? { day, tokens: 0, replies: 0 }
  d.tokens += tokens
  d.replies++
  t.days.set(day, d)
  // Replies from before models were recorded count under the chat's model.
  const model = m.model ?? (conv ? { backendId: conv.backendId, id: conv.modelId, name: conv.models?.find((x) => x.id === conv.modelId)?.name } : undefined)
  if (!model) return
  const key = `${model.backendId}\0${model.id ?? ''}`
  const u = t.models.get(key) ?? { backendId: model.backendId, ...(model.id ? { id: model.id } : {}), tokens: 0, replies: 0 }
  if (model.name) u.name = model.name
  u.tokens += tokens
  u.replies++
  t.models.set(key, u)
}
