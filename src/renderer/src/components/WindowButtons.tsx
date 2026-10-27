import { Minus, Square, X } from 'lucide-react'
import { t } from '@shared/i18n'

export function WindowButtons({ onAction, className = 'winctl' }: { onAction: (action: 'minimize' | 'maximize' | 'close') => void; className?: string }) {
  return <div className={className}>
    <button aria-label={t('最小化')} onClick={() => onAction('minimize')}><Minus size={15} /></button>
    <button aria-label={t('全屏')} onClick={() => onAction('maximize')}><Square size={12} /></button>
    <button className="close" aria-label={t('关闭')} onClick={() => onAction('close')}><X size={16} /></button>
  </div>
}
