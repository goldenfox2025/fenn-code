/**
 * The steps shown on a conversation's plan card. The backend's own ACP plan
 * wins while it sends one (it replaces the whole list each time); otherwise the
 * checklist the agent wrote with update_status. Rows the app knows about but
 * ACP has no status for (waiting on the user, a message waiting for another
 * thread) are added after, so a plan replacement never drops them.
 */
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
  /(审批|决策)卡/,
  /^(等|等待)(你|您|用户)(的)?(选择|回复|确认|决定|答复)/,
  /^(reply|respond|answer)( to)?( the)? user\.?$/i,
  /^(reply|respond)\.?$/i,
  /^send (the |a )?(decision |approval )?card/i,
  /^wait(ing)? for (the )?user/i
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
