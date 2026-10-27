import type { Conversation } from '@shared/model'
import { t } from '../../i18n'
export function reviewStage(c: Conversation): 'checking' | 'changes' | 'discussion' | 'ready' {
  const r = c.review!
  if (c.status === 'working' || !r.recommendation) return 'checking'
  if (r.recommendation.verdict === 'needs_discussion') return 'discussion'
  return r.assessment?.blockers.length || r.recommendation.verdict === 'changes_requested' ? 'changes' : 'ready'
}

export function reviewQueueStatus(c: Conversation): string {
  const stage = reviewStage(c)
  if (stage === 'checking') return t('核对中')
  if (stage === 'discussion') return t('待讨论')
  if (stage === 'changes') return c.review!.kind === 'finding' ? t('需补证') : t('需修改')
  return c.review!.kind === 'finding' ? t('待采纳') : t('待决定')
}

export function reviewStatus(c: Conversation): string {
  const r = c.review!
  if (r.state === 'accepted') return r.kind === 'finding' ? t('已采纳') : t('已通过')
  if (r.state === 'returned') return r.kind === 'finding' ? t('继续分析') : t('已退回')
  if (r.state === 'stale') return t('需重新提交')
  if (r.state === 'merging') return r.kind === 'finding' ? t('正在记录') : t('正在合并')
  if (r.recommendation?.verdict === 'needs_discussion') return t('待讨论')
  if (r.assessment?.blockers.length || r.recommendation?.verdict === 'changes_requested') return r.kind === 'finding' ? t('需补充证据') : t('需要修改')
  return r.recommendation?.verdict === 'ready' ? t('待您决定') : t('主对话分析中')
}
