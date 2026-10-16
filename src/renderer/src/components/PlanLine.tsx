import { useState } from 'react'
import { ChevronRight, CircleAlert, ListChecks } from 'lucide-react'
import { currentBlocker, planProgress, type Conversation } from '@shared/model'
import { Checklist } from './Transcript'
import { relTime } from '../util'
import { t } from '../i18n'

/**
 * What the agent is working on in this conversation: a quiet one-line summary
 * (current step, steps done, current obstacle) that opens into the full plan
 * and the obstacles met so far.
 */
export function PlanLine({ conv, defaultOpen }: { conv: Conversation; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const progress = planProgress(conv.checklist)
  const blocker = currentBlocker(conv)
  const past = (conv.blockers ?? []).filter((b) => b !== blocker).reverse()
  if (!progress && !blocker && !past.length) return null
  const allDone = progress && progress.done === progress.total
  return (
    <div className={'plan-line' + (open ? ' open' : '')}>
      <button className="plan-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListChecks size={14} className="plan-icon" />
        <span className="plan-text">
          {progress
            ? allDone
              ? t('计划已完成 {0}/{1}', progress.done, progress.total)
              : `${progress.step ?? t('计划')} · ${progress.done}/${progress.total}`
            : t('计划')}
        </span>
        {blocker && (
          <span className="plan-blocker" title={blocker.text}>
            <CircleAlert size={13} />
            {t('难点：{0}', blocker.text)}
          </span>
        )}
        <ChevronRight size={14} className="chev" />
      </button>
      {open && (
        <div className="plan-body">
          {conv.checklist && <Checklist text={withoutTitle(conv.checklist, conv.title)} />}
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

/** The plan's own heading repeats the conversation title right above it; drop it then. */
function withoutTitle(checklist: string, title: string): string {
  const [head, ...rest] = checklist.split('\n')
  return head.replace(/\*\*/g, '').trim() === title.trim() ? rest.join('\n').replace(/^\n+/, '') : checklist
}

/** One short line for cards: the current obstacle, else the step in progress. */
export function planHeadline(conv: Conversation): string | undefined {
  const b = currentBlocker(conv)
  if (b) return t('难点：{0}', b.text)
  return planProgress(conv.checklist)?.step
}
