import { useEffect, useState } from 'react'
import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, ListChecks, LoaderCircle } from 'lucide-react'
import { currentBlocker, planProgress, type Block, type Conversation } from '@shared/model'
import { planEntries, type PlanEntry } from '@shared/plan'
import { useApp } from '../store'
import { duration, relTime } from '../util'
import { t } from '../i18n'

/** When each step was first seen in progress in a turn, for its elapsed time (this window only). */
const startedAt = new Map<string, number>()

/** The ACP plan of the latest reply, if the backend sent one. */
function useAcpPlan(conversationId: string) {
  return useApp((s) => {
    const list = s.messages[conversationId]
    if (!list) return undefined
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.role !== 'assistant' || m.hidden) continue
      return m.blocks.find((b): b is Extract<Block, { type: 'plan' }> => b.type === 'plan')?.entries
    }
    return undefined
  })
}

/** The turn now on screen: its user message (each turn starts with one), so times restart each turn. */
function useTurnKey(conversationId: string): string {
  return useApp((s) => {
    const list = s.messages[conversationId] ?? []
    for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') return list[i].id
    return ''
  })
}

/** Rows the app adds: what this conversation is waiting on, which ACP has no status for; `live` is work under way. */
function useWaiting(conv: Conversation): { rows: string[]; live: Set<string> } {
  const peers = useApp((s) => s.peerMessages)
  const conversations = useApp((s) => s.conversations)
  const outgoing = peers
    .filter((m) => m.fromId === conv.id && m.state === 'pending')
    .map((m) => ({ deliver: m.deliver, to: conversations.find((c) => c.id === m.toId)?.title ?? '' }))
  const rows: string[] = []
  const live = new Set<string>()
  if (conv.needsUser?.kind === 'decision') rows.push(t('等您决定：{0}', conv.needsUser.text ?? ''))
  // A permission request is not listed: its card is right below, and the row would blink between two requests.
  for (const o of outgoing) {
    const row = o.deliver === 'when_idle' ? t('等「{0}」空闲后交接', o.to) : o.deliver === 'now' ? t('正在交给「{0}」', o.to) : t('等「{0}」完成后交接', o.to)
    rows.push(row)
    if (o.deliver === 'now') live.add(row)
  }
  return { rows, live }
}

function StepIcon({ status, live }: { status: PlanEntry['status']; live: boolean }) {
  if (status === 'done') return <CircleCheck size={15} className="step-icon done" />
  // A step left in progress when the turn ended isn't running any more: it stops spinning.
  if (status === 'doing') return <LoaderCircle size={15} className={'step-icon doing' + (live ? ' live' : '')} />
  if (status === 'waiting') return <CircleDot size={15} className="step-icon waiting" />
  return <Circle size={15} className="step-icon pending" />
}

/** Re-renders every second while something is running, for the elapsed time. */
function useTick(on: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => set((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [on])
}

/**
 * The conversation's plan, as Claude shows it: a card at the top that stays
 * put while the conversation scrolls and updates in place. Each step has its
 * state icon (done, running with its time, waiting, not started); it folds to
 * one line. Obstacles met along the way are listed under the steps.
 */
export function PlanLine({ conv, defaultOpen }: { conv: Conversation; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const acp = useAcpPlan(conv.id)
  const turn = useTurnKey(conv.id)
  const waiting = useWaiting(conv)
  const entries = planEntries({ checklist: conv.checklist, acp, waiting: waiting.rows })
  const blocker = currentBlocker(conv)
  const past = (conv.blockers ?? []).filter((b) => b !== blocker).reverse()
  const working = conv.status === 'working'
  const doing = entries.find((e) => e.status === 'doing')
  useTick(working && !!doing)
  // A new turn opens the card again, as when the thread is opened mid-turn.
  useEffect(() => {
    if (working) setOpen(true)
  }, [working, turn])
  // A plan that just finished folds to its one line, as in Claude.
  const finished = !working && entries.length > 0 && entries.every((e) => e.status === 'done')
  useEffect(() => {
    if (finished) setOpen(false)
  }, [finished])
  if (!entries.length && !blocker && !past.length) return null
  const steps = entries.filter((e) => !e.app)
  const done = steps.filter((e) => e.status === 'done').length
  const allDone = steps.length > 0 && done === steps.length
  const since = (e: PlanEntry) => {
    const key = `${conv.id}|${turn}|${e.text}`
    if (!startedAt.has(key)) startedAt.set(key, Date.now())
    return startedAt.get(key)!
  }
  const current = doing ?? entries.find((e) => e.status === 'waiting')
  return (
    <div className={'plan-line' + (open ? ' open' : '')}>
      <button className="plan-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListChecks size={14} className="plan-icon" />
        <span className="plan-text">
          {steps.length
            ? allDone
              ? t('计划已完成')
              : open ? t('计划') : (current?.text ?? t('计划'))
            : (open ? t('计划') : current?.text ?? t('计划'))}
        </span>
        {steps.length > 0 && <span className="plan-count">{done}/{steps.length}</span>}
        {blocker && (
          <span className="plan-blocker" data-tip={!open ? blocker.text : undefined} aria-hidden={open || undefined} aria-label={!open ? t('难点：{0}', blocker.text) : undefined}>
            {!open && <><CircleAlert size={13} />{t('难点')}</>}
          </span>
        )}
        <ChevronRight size={14} className="chev" />
      </button>
      {open && (
        <div className="plan-body">
          {entries.length > 0 && (
            <ol className="checklist plan-steps">
              {entries.map((e, i) => (
                <li key={i} className={'plan-step ' + e.status}>
                  <StepIcon status={e.status} live={working} />
                  <span className={'plan-step-text' + (e.app && waiting.live.has(e.text) ? ' shimmer' : '')}>{e.text}</span>
                  {e.status === 'doing' && working && Date.now() - since(e) >= 1000 && <span className="plan-step-time">{duration(Date.now() - since(e))}</span>}
                </li>
              ))}
            </ol>
          )}
          {blocker && (
            <div className="plan-current-blocker">
              <span className="label">{t('当前难点')}</span>
              {blocker.text}
              <span className="muted"> · {relTime(blocker.at)}</span>
            </div>
          )}
          {past.length > 0 && (
            <details className="plan-history">
              <summary>{t('之前的难点 · {0}', past.length)}</summary>
              {past.map((b, i) => (
                <div key={i} className="plan-history-item">
                  {b.text}
                  <span className="muted"> · {relTime(b.at)}{b.resolvedAt ? t('，已解决') : ''}</span>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/** One short line for cards: the current obstacle, else the step in progress. */
export function planHeadline(conv: Conversation): string | undefined {
  const b = currentBlocker(conv)
  if (b) return t('难点：{0}', b.text)
  return planProgress(conv.checklist)?.step
}
