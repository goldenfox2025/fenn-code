import { useEffect, useState } from 'react'
import { Globe, Square } from 'lucide-react'
import type { BrowserFrame, BrowserViewService } from '@shared/browser'
import { t } from '@shared/i18n'

/** Capture lives only while this viewer is visible, never in the global application snapshot. */
export function BrowserView({ ownerId, service }: { ownerId: string; service: BrowserViewService }) {
  const [frame, setFrame] = useState<BrowserFrame | null>(null), [error, setError] = useState(''), [stopping, setStopping] = useState(false)
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>
    setFrame(null); setError('')
    const read = async () => {
      try { const result = await service.frame(ownerId); if (live) { setFrame(result); setError('') } }
      catch (cause) { if (live) setError(cause instanceof Error ? cause.message : String(cause)) }
      if (live) timer = setTimeout(read, 800)
    }
    void read()
    return () => { live = false; clearTimeout(timer) }
  }, [ownerId, service])
  return <section className="browser-view" aria-label={t('浏览器画面')}>
    {frame ? <>
      <div className="browser-view-address"><Globe size={15} /><span data-tip={frame.url}>{frame.url}</span>{frame.active && <button className="btn" disabled={stopping} onClick={async () => { setStopping(true); try { await service.stop(ownerId); setFrame(current => current && { ...current, active: false }) } catch (cause) { setError(String(cause)) } finally { setStopping(false) } }}><Square size={12} />{t('停止')}</button>}</div>
      {frame.image && <img src={`data:${frame.mimeType || 'image/png'};base64,${frame.image}`} alt={frame.title || t('浏览器操作画面')} />}
      <div className="browser-view-caption"><span className={frame.active ? 'browser-live' : ''}>{frame.active ? frame.stale ? t('等待画面更新') : t('实时画面') : t('操作已结束 · 最后画面')}</span><span>{frame.mode === 'existing' ? t('现有浏览器的后台标签页') : t('独立无头浏览器')}</span></div>
    </> : <p className="browser-view-empty">{t('网页打开后，操作画面会显示在这里。')}</p>}
    {error && <p className="memory-error" role="alert">{error}</p>}
  </section>
}
