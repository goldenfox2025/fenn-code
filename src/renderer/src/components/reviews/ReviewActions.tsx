import { useLayoutEffect, useRef, useState } from 'react'
import { Check, GitMerge, LoaderCircle, MessageSquare } from 'lucide-react'
import { t } from '../../i18n'

/** Keep the main decision readable; compact the secondary action only when both labels cannot fit. */
export function ReviewActions({ busy, editing, ready, finding, workspace, canAct, onReturn, onAccept }: {
  busy: boolean; editing: boolean; ready: boolean; finding: boolean; workspace: boolean; canAct: boolean
  onReturn: () => void; onAccept: () => void
}) {
  const row = useRef<HTMLDivElement>(null)
  const secondary = useRef<HTMLButtonElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    if (!ready) { setCompact(false); return }
    const root = row.current!, button = secondary.current!, text = label.current!, action = primary.current!
    const fit = () => {
      if (!root.clientWidth) return
      const style = getComputedStyle(button), spacing = getComputedStyle(root)
      const number = (value: string) => parseFloat(value) || 0
      const secondaryWidth = text.getBoundingClientRect().width + 14 + number(style.columnGap)
        + number(style.paddingLeft) + number(style.paddingRight) + number(style.borderLeftWidth) + number(style.borderRightWidth)
      setCompact(secondaryWidth + action.getBoundingClientRect().width + number(spacing.columnGap) > root.clientWidth + 0.5)
    }
    const observer = new ResizeObserver(fit)
    observer.observe(root); observer.observe(text); observer.observe(action)
    fit()
    return () => observer.disconnect()
  }, [ready, finding, workspace])
  const returnLabel = t('提出意见')
  return <div className="review-actions" ref={row}>
    <button ref={secondary} className={'btn review-return' + (compact ? ' compact' : '') + (!ready ? ' primary' : '')} disabled={busy || !canAct} aria-label={returnLabel} aria-pressed={editing} data-tip={compact ? returnLabel : undefined} onClick={onReturn}><MessageSquare size={14} /><span ref={label} className="review-return-label" aria-hidden={compact || undefined}>{returnLabel}</span></button>
    {ready && <button ref={primary} className="btn primary" disabled={busy || editing} onClick={onAccept}>{busy ? <LoaderCircle size={14} /> : finding ? <Check size={14} /> : <GitMerge size={14} />}{finding ? t('采纳分析') : workspace ? t('批准并合并') : t('通过验收')}</button>}
  </div>
}
