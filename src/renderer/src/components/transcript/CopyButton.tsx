import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { t } from '../../i18n'
export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="icon-btn sm"
      aria-label={t('复制')}
      data-tip={t('复制')}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}
