import { Loader } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { t } from '../i18n'
import { STATUS_LABEL, threadState } from '../util'

/** A thread's or sub-chat's state as a chip: 进行中 with a spinner, 等待您, 已完成, 出错, or 已解决. */
export function StatusChip({ conv }: { conv: Conversation }) {
  const st = threadState(conv)
  return (
    <span className={'status-chip ' + st}>
      {st === 'working' && <Loader size={11} className="spark" />}
      {conv.resolved ? t('已解决') : STATUS_LABEL[st]}
    </span>
  )
}
