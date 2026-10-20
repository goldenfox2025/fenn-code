import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { FoxMark } from './FoxMark'

/** One working indicator for replies and previews, tied to their real lifecycle. */
export function WorkingMark({ since, label }: { since: number; label?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const s = Math.max(0, Math.round((Date.now() - since) / 1000))
  return (
    <div className="working-mark" role="status">
      <FoxMark thinking />
      {label && <span>{label}</span>}
      <span className="working-time">{s < 60 ? t('{0} 秒', s) : t('{0} 分 {1} 秒', Math.floor(s / 60), s % 60)}</span>
    </div>
  )
}
