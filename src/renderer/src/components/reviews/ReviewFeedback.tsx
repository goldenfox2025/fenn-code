import { t } from '../../i18n'

/** Comments stay in the inspector; they never resize the dock or route a message. */
export function ReviewFeedback({ feedback, busy, canSend, onFeedback, onCancel, onSend }: {
  feedback: string; busy: boolean; canSend: boolean
  onFeedback: (value: string) => void; onCancel: () => void; onSend: () => void
}) {
  return <form className="review-controls" onSubmit={(e) => { e.preventDefault(); if (canSend && !busy) onSend() }}>
    <label className="review-feedback">{t('反馈意见')}
      <textarea className="textarea" value={feedback} onChange={(e) => onFeedback(e.target.value)} placeholder={t('说明疑问、修改要求，或希望重新讨论的方向')} rows={2} autoFocus disabled={busy} />
    </label>
    <div className="review-control-row"><span className="review-feedback-hint">{t('主对话会分析并回应')}</span>
      <div className="review-actions"><button className="btn" type="button" disabled={busy} onClick={onCancel}>{t('取消')}</button><button className="btn primary" type="submit" disabled={busy || !canSend}>{t('提交意见')}</button></div>
    </div>
  </form>
}
