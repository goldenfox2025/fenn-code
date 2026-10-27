import { RotateCcw, Split } from 'lucide-react'
import type { Message } from '@shared/model'
import { api } from '../../store'
import { t } from '../../i18n'
import { textOf } from '../../util'
import { MessageUsageLabel } from '../Usage'
import { CopyButton } from './CopyButton'


/** One footer at a settled reply boundary; no task execution or usage estimation here. */
export function TurnFooter({ message: m, canThread, canRegenerate }: { message: Message; canThread?: boolean; canRegenerate?: boolean }) {
  const text = textOf(m)

  return <div className="msg-actions assistant-actions">
    {!!text && <CopyButton text={text} />}
    {canRegenerate && <button className="icon-btn sm" aria-label={t('重新生成')} data-tip={t('重新生成')} onClick={() => void api().regenerate(m.conversationId)}><RotateCcw size={14} /></button>}
    {canThread && <button className="icon-btn sm" aria-label={t('转为讨论串')} data-tip={t('转为讨论串')} onClick={() => void api().convertToThread(m.conversationId, m.id)}><Split size={14} /></button>}
    <MessageUsageLabel m={m} />
  </div>
}
