import { useEffect, useId, useState } from 'react'
import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, ListChecks, LoaderCircle } from 'lucide-react'
import { currentBlocker, planProgress, type Conversation } from '@shared/model'
import { currentPlan, planWindow, type PlanEntry } from '@shared/plan'
import { useApp } from '../store'
import { relTime } from '../util'
import { t } from '../i18n'
import { usePanePresence } from './usePanePresence'

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
  if (status === 'doing') return live ? <LoaderCircle size={15} className="step-icon doing live" /> : <Circle size={15} className="step-icon pending" />
  if (status === 'waiting') return <CircleDot size={15} className="step-icon waiting" />
  return <Circle size={15} className="step-icon pending" />
}

/**
 * One live plan at the end of the transcript. It shares the message column and
 * scrolls with it; permission/review controls stay in their own composer slot.
 * Only structured events change completion. Stopped and carried-over steps
 * never keep spinning or acquire a checkmark merely because a reply ended.
 */
export function PlanLine({ conv }: { conv: Conversation }) {
  const [open, setOpen] = useState(conv.status === 'working')
  const [showAll, setShowAll] = useState(false)
  const id = useId()
  const messages = useApp(s => s.messages[conv.id])
  const plan = currentPlan(conv, messages ?? [])
  const waiting = useWaiting(conv)
  const steps = plan.entries
  const entries: PlanEntry[] = [...steps, ...waiting.rows.map(text => ({ text, status: 'waiting' as const, app: true }))]
  const blocker = currentBlocker(conv)
  const past = (conv.blockers ?? []).filter((b) => b !== blocker).reverse()
  const working = conv.status === 'working' && !plan.stale && !conv.resolved
  const doing = entries.find((e) => e.status === 'doing')
  // A new turn opens the card again, as when the thread is opened mid-turn.
  useEffect(() => {
    if (working) setOpen(true)
  }, [working, plan.turn])
  useEffect(() => setShowAll(false), [plan.turn])
  // A plan that just finished folds to its one line, as in Claude.
  const finished = !working && entries.length > 0 && entries.every((e) => e.status === 'done')
  useEffect(() => {
    if (finished || conv.resolved) setOpen(false)
  }, [finished, conv.resolved])
  const presence = usePanePresence(open)
  if (!entries.length && !blocker) return null
  const done = steps.filter((e) => e.status === 'done').length
  const allDone = steps.length > 0 && done === steps.length
  const windowed = planWindow(steps)
  const shown = showAll ? entries : [...windowed.entries, ...entries.filter(e => e.app)]
  const current = doing ?? entries.find((e) => e.status === 'waiting')
  const label = plan.stale && steps.length ? t('此前的计划') : conv.resolved && !allDone ? t('已结束 · 计划记录') : allDone ? t('计划已完成') : !working && doing && conv.status !== 'waiting' ? t('计划未完成') : open ? t('计划') : (current?.text ?? t('计划'))
  return (
    <section className={'plan-line' + (open ? ' open' : '')} aria-label={t('任务计划')} data-stale={plan.stale || undefined}>
      <button className="plan-summary" aria-expanded={open} aria-controls={presence.present ? id : undefined} onClick={() => setOpen(!open)}>
        <ListChecks size={14} className="plan-icon" />
        <span className="plan-text">
          {label}
        </span>
        {steps.length > 0 && <span className="plan-count">{done}/{steps.length}</span>}
        {blocker && (
          <span className="plan-blocker" data-tip={!open ? blocker.text : undefined} aria-hidden={open || undefined} aria-label={!open ? t('难点：{0}', blocker.text) : undefined}>
            {!open && <><CircleAlert size={13} />{t('难点')}</>}
          </span>
        )}
        <ChevronRight size={14} className="chev" />
      </button>
      {presence.present && (
        <div className="steps-fold" data-exiting={presence.exiting || undefined} inert={presence.exiting} id={id}>
        <div className="steps-clip"><div className="plan-body">
          {plan.stale && steps.length > 0 && <p className="plan-note">{t('本轮尚未更新此计划')}</p>}
          {!showAll && windowed.before > 0 && <p className="plan-note">{t('前面还有 {0} 步', windowed.before)}</p>}
          {entries.length > 0 && (
            <ol className="checklist plan-steps">
              {shown.map((e, i) => (
                <li key={i} className={'plan-step ' + e.status}>
                  <StepIcon status={e.status} live={working} />
                  <span className={'plan-step-text' + (e.app && waiting.live.has(e.text) ? ' shimmer' : '')}>{e.text}</span>
                </li>
              ))}
            </ol>
          )}
          {steps.length > 6 && <button className="plan-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? t('只看当前步骤') : t('查看全部 {0} 步', steps.length)}{!showAll && windowed.after > 0 && <span>{t('后续 {0} 步', windowed.after)}</span>}</button>}
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
        </div></div></div>
      )}
    </section>
  )
}

/** One short line for cards: the current obstacle, else the step in progress. */
export function planHeadline(conv: Conversation): string | undefined {
  if (conv.resolved) return undefined
  const b = currentBlocker(conv)
  if (b) return t('难点：{0}', b.text)
  return planProgress(conv.checklist)?.step
}
