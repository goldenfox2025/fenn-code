/**
 * The steps shown on a conversation's plan card. The backend's own ACP plan
 * wins while it sends one (it replaces the whole list each time); otherwise the
 * checklist the agent wrote with update_status. Rows the app knows about but
 * ACP has no status for (waiting on the user, a message waiting for another
 * thread) are added after, so a plan replacement never drops them.
 */
import type { Conversation, Message } from './model'

export type PlanStatus = 'done' | 'doing' | 'waiting' | 'pending'

export interface PlanEntry {
  text: string
  status: PlanStatus
  /** Added by the app, not written by the agent. */
  app?: boolean
}

export interface AcpPlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

const MARKS: Record<string, PlanStatus> = { '✓': 'done', '✱': 'doing', '○': 'pending', '⊙': 'waiting' }
const ACP: Record<AcpPlanEntry['status'], PlanStatus> = { completed: 'done', in_progress: 'doing', pending: 'pending' }

/**
 * Steps that only narrate what the interface does anyway (replying, sending a
 * card, waiting for the user): the card already shows those, so they're left out.
 */
const BOOKKEEPING = [
  /^(回复|答复|回答)(用户|您|你)?[。.]?$/,
  /^(发|发出|发送|给出?)(用户)?(一张)?(审批|决策|选择)?卡片?/,
  /^(展示|显示|生成)?(审批|决策)卡(片)?[。.]?$/,
  /^(等|等待)(你|您|用户)(的)?(选择|回复|确认|决定|答复)/,
  /^(reply|respond|answer)( to)?( the)? user\.?$/i,
  /^(reply|respond)\.?$/i,
  /^send (the |a )?(decision |approval )?card/i,
  /^wait(ing)? for (the )?user/i
  , /^(标记|将).*(讨论串|任务|对话).*(完成|解决)/
  , /^mark (the )?(thread|task|conversation) (as )?(done|complete|resolved)/i
]

export const isBookkeeping = (text: string): boolean => BOOKKEEPING.some((r) => r.test(text.trim()))

function fromChecklist(checklist: string): PlanEntry[] {
  const out: PlanEntry[] = []
  for (const raw of checklist.split('\n')) {
    const l = raw.replace(/\*\*/g, '').trim()
    const status = MARKS[l[0]]
    if (!status) continue
    const text = l.slice(1).trim()
    if (text) out.push({ text, status })
  }
  return out
}

export function planEntries(input: { checklist?: string; acp?: AcpPlanEntry[]; waiting?: string[] }): PlanEntry[] {
  const own = input.acp?.length
    ? input.acp.map((e) => ({ text: e.content.trim(), status: ACP[e.status] ?? 'pending' })).filter((e) => e.text)
    : fromChecklist(input.checklist ?? '')
  const steps = own.filter((e) => !isBookkeeping(e.text))
  return [...steps, ...(input.waiting ?? []).map((text) => ({ text, status: 'waiting' as const, app: true }))]
}

/** Only this turn's visible replies can supply its live plan. Hidden housekeeping
 * and assistant continuations without a plan must not replace that state. */
export function currentPlan(conv: Pick<Conversation, 'checklist' | 'checklistAuto' | 'checklistUpdatedAt'>, messages: Message[]) {
  const userIndex = messages.findLastIndex(m => m.role === 'user' && !m.hidden && !m.housekeeping && !m.action)
  const user = messages[userIndex]
  for (let i = messages.length - 1; i > userIndex; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || message.hidden || message.housekeeping || message.action) continue
    const plan = message.blocks.findLast(b => b.type === 'plan')
    if (plan?.type === 'plan') {
      // ACP and update_status both publish the canonical checklist. A later
      // update_status in this turn may supersede the stored ACP block.
      const canonical = !conv.checklistAuto && conv.checklistUpdatedAt !== undefined && conv.checklistUpdatedAt >= message.createdAt
      return { entries: canonical ? planEntries({ checklist: conv.checklist }) : planEntries({ acp: plan.entries }), stale: false, turn: user?.id ?? '' }
    }
  }
  const entries = conv.checklistAuto ? [] : planEntries({ checklist: conv.checklist })
  const stale = !!user && (conv.checklistUpdatedAt === undefined || conv.checklistUpdatedAt < user.createdAt)
  // A finished previous task does not decorate an unrelated new question.
  return { entries: stale && entries.every(e => e.status === 'done') ? [] : entries, stale, turn: user?.id ?? '' }
}

/** Keep a long plan focused around its first unfinished step, without changing
 * the underlying plan or hiding whether more steps remain. */
export function planWindow(entries: PlanEntry[], limit = 6) {
  const active = entries.findIndex(e => e.status !== 'done')
  const start = Math.max(0, Math.min(active < 0 ? entries.length - limit : active - 1, entries.length - limit))
  return { entries: entries.slice(start, start + limit), before: start, after: Math.max(0, entries.length - start - limit) }
}
