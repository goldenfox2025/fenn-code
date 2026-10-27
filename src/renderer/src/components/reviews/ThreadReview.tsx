import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Check, ChevronDown, LoaderCircle, MessageSquare, RefreshCw, ShieldCheck, Undo2, CircleAlert, X } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { api, toastError } from '../../store'
import { reviewStatus } from './reviewState'
import { ReviewActions } from './ReviewActions'
import { ReviewDetails } from './ReviewDetails'
import { ReviewFeedback } from './ReviewFeedback'
import { t } from '../../i18n'

/** Owns revision-scoped drafts and decisions. The inspector never changes the dock's geometry. */
export function ThreadReview({ thread, onOpenThread, onOpenMain, wide = false }: { thread: Conversation; onOpenThread: (id: string) => void; onOpenMain: () => void; wide?: boolean }) {
  const review = thread.review!
  const draftKey = `review-feedback:${thread.id}:${review.id}`
  const [feedback, setFeedback] = useState(() => sessionStorage.getItem(draftKey) ?? '')
  const [returning, setReturning] = useState(() => sessionStorage.getItem(`${draftKey}:open`) === '1')
  const editFeedback = (open: boolean) => { setReturning(open); sessionStorage.setItem(`${draftKey}:open`, open ? '1' : '0') }
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(returning)
  const card = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const detailId = useId()
  const [inspectorHost, setInspectorHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setInspectorHost(card.current!.closest('.thread-view')!.querySelector<HTMLElement>('.thread-reading-area'))
  }, [])
  useEffect(() => {
    let active = true
    if (review.state === 'pending') void api().inspectDelivery(thread.id, review.id).catch((e) => { if (active) toastError(e) })
    return () => { active = false }
  }, [thread.id, review.id, review.state])
  const finding = review.kind === 'finding'
  const blockers = review.assessment?.blockers ?? []
  const pending = review.state === 'pending'
  const discussion = review.recommendation?.verdict === 'needs_discussion'
  const needsChanges = !!blockers.length || review.recommendation?.verdict === 'changes_requested'
  const ready = pending && thread.status !== 'working' && review.recommendation?.verdict === 'ready' && !blockers.length && (finding || thread.taskKind !== 'change' || !!review.recommendation.integrationPlan)
  const count = review.assessment?.files.length ?? 0
  const act = async (action: 'accept' | 'discuss') => {
    setBusy(true)
    try {
      if (action === 'accept') await api().acceptDelivery(thread.id, review.id)
      else await api().discussDelivery(thread.id, review.id, feedback)
      editFeedback(false); setFeedback(''); sessionStorage.removeItem(draftKey)
      toggle.current?.focus({ preventScroll: true })
    } catch (e) { toastError(e) } finally { setBusy(false) }
  }
  const inspect = async () => {
    setBusy(true)
    try { await api().inspectDelivery(thread.id, review.id, true) } catch (e) { toastError(e) } finally { setBusy(false) }
  }
  const closeDetails = () => { setExpanded(false); toggle.current?.focus({ preventScroll: true }) }
  return <section ref={card} className={'thread-review' + (expanded ? ' expanded' : '')} aria-label={t('主对话建议')} aria-busy={busy} onKeyDown={(e) => { if (e.key === 'Escape' && expanded) { e.preventDefault(); e.stopPropagation(); closeDetails() } }}>
    <div className="review-card-heading"><button ref={toggle} className={'review-decision' + (review.state === 'accepted' ? ' accepted' : needsChanges || review.state === 'stale' ? ' needs-changes' : '')} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => setExpanded(!expanded)}>
      {review.state === 'accepted' ? <Check size={16} /> : review.state === 'returned' ? <Undo2 size={16} /> : review.state === 'merging' || !review.recommendation ? <LoaderCircle size={16} className="spark" /> : discussion ? <MessageSquare size={16} /> : needsChanges || review.state === 'stale' ? <CircleAlert size={16} /> : <ShieldCheck size={16} />}
      <span className="review-kind">{pending ? t('主对话建议') : reviewStatus(thread)}</span>
      <span className="spacer" />{!!count && <span className="review-result">{t('{0} 个文件', count)}</span>}<ChevronDown size={14} className={expanded ? 'turned' : ''} />
    </button>{pending && <button className="icon-btn review-recheck" aria-label={t('重新核对')} data-tip={t('重新核对')} disabled={busy} onClick={() => void inspect()}><RefreshCw size={14} /></button>}</div>
    {pending && <p className="review-verdict" data-tip={review.recommendation?.summary}>{review.recommendation?.summary || t('正在核对证据和影响…')}</p>}
    {expanded && inspectorHost && createPortal(<div id={detailId} className="review-detail-popover" role="region" aria-label={t('审核详情')}>
      <div className="review-detail-heading"><strong>{t('审核详情')}</strong><span className="spacer" /><button className="icon-btn" aria-label={t('收起审核详情')} onClick={closeDetails}><X size={15} /></button></div>
      <ReviewDetails threadId={thread.id} review={review} onOpenThread={onOpenThread} wide={wide} />
      {pending && returning && <ReviewFeedback feedback={feedback} busy={busy} canSend={!!feedback.trim() && thread.status !== 'working'} onFeedback={(value) => { setFeedback(value); sessionStorage.setItem(draftKey, value) }} onCancel={() => { editFeedback(false); card.current?.querySelector<HTMLButtonElement>('.review-return')?.focus({ preventScroll: true }) }} onSend={() => void act('discuss')} />}
    </div>, inspectorHost)}
    {pending && <div className="review-control-row">
      {discussion && <button className="link review-main-link" onClick={onOpenMain}>{t('在主对话讨论')}<ArrowUpRight size={13} /></button>}
      <ReviewActions busy={busy} editing={returning && expanded} ready={ready} finding={finding} workspace={!!thread.workspace} canAct={thread.status !== 'working'} onReturn={() => { setExpanded(true); editFeedback(true) }} onAccept={() => void act('accept')} />
    </div>}
    {!pending && <button className="link review-main-link" onClick={onOpenMain}>{t('在主对话继续讨论')}<ArrowUpRight size={13} /></button>}
  </section>
}
