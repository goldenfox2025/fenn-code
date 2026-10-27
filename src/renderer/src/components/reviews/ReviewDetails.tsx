import { useLayoutEffect, useRef } from 'react'
import { ArrowUpRight, ChevronRight, FileCode2 } from 'lucide-react'
import type { DeliveryReview } from '@shared/model'
import { openDeliveryFile } from '../../store'
import { Markdown } from '../Transcript'
import { t } from '../../i18n'

/** Files establish what is being reviewed; the coordinator's analysis explains why. */
export function ReviewDetails({ threadId, review, onOpenThread, wide }: { threadId: string; review: DeliveryReview; onOpenThread: (id: string) => void; wide: boolean }) {
  const scroll = useRef<HTMLDivElement>(null)
  const scrollKey = `review-scroll:${threadId}:${review.id}`
  useLayoutEffect(() => { scroll.current!.scrollTop = Number(sessionStorage.getItem(scrollKey)) || 0 }, [scrollKey])
  const changes = review.assessment?.changes ?? review.assessment?.files.map((path) => ({ path, status: 'modified' as const, added: undefined, removed: undefined })) ?? []
  const blockers = review.assessment?.blockers ?? []
  return <div ref={scroll} className="review-detail-body" onScroll={(e) => sessionStorage.setItem(scrollKey, String(e.currentTarget.scrollTop))}>
    {!!changes.length && <div className="review-changes">
      <div className="review-section-title"><strong>{t('更改的文件')}</strong><span>{changes.length}</span>{changes.length > 3 && <button className="link review-all-files" onClick={() => openDeliveryFile(threadId, review.id, changes[0].path, wide)}>{t('查看全部')}</button>}</div>
      {changes.slice(0, 3).map((file) => <button className="review-file-row" key={file.path} onClick={() => openDeliveryFile(threadId, review.id, file.path, wide)} aria-label={t('查看更改：{0}', file.path)}><FileCode2 size={14} /><span className="review-file-name">{file.path}</span><span className="review-file-status">{file.status === 'added' ? t('新增') : file.status === 'deleted' ? t('删除') : t('修改')}</span>{file.added !== undefined && <span className="review-added">+{file.added}</span>}{file.removed !== undefined && <span className="review-removed">−{file.removed}</span>}<ChevronRight size={13} /></button>)}
    </div>}
    {review.feedback && <div className="review-returned"><strong>{t('反馈意见')}</strong><Markdown text={review.feedback} /></div>}
    {review.recommendation?.notes && <div className="review-opinion"><Markdown text={review.recommendation.notes} /></div>}
    {review.recommendation?.integrationPlan && <div className="review-integration"><strong>{t('合入方式与影响')}</strong><Markdown text={review.recommendation.integrationPlan} /></div>}
    {!!blockers.length && <div className="review-blockers"><strong>{t('合并前需要处理')}</strong><ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
    {!!review.assessment?.overlaps.length && <div className="review-overlaps"><span>{t('这些方向涉及相同文件，请结合主对话分析判断')}</span>{review.assessment.overlaps.map((o) => <button className="link" key={o.threadId} onClick={() => onOpenThread(o.threadId)}>{o.title}<ArrowUpRight size={12} /></button>)}</div>}
    <details className="review-evidence" open={!review.recommendation}>
      <summary>{t('交付概览')}</summary><div className="review-summary"><Markdown text={review.summary} /></div>
      {review.checks && <Markdown text={review.checks} />}{review.unverified && <><strong>{t('尚未验证')}</strong><Markdown text={review.unverified} /></>}
    </details>
    {review.state === 'stale' && <p className="review-hint">{t('交付已变化，请进入讨论串重新提交验收。')}</p>}
  </div>
}
