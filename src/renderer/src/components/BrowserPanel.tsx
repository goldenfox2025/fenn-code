import { useEffect, useState } from 'react'
import { Globe, PanelRightClose } from 'lucide-react'
import { api, useApp } from '../store'
import { BrowserView } from './BrowserView'
import { PreviewPane } from './PreviewPane'
import type { BrowserViewService } from '@shared/browser'
import { t } from '../i18n'

const service: BrowserViewService = { info: id => api().browserInfo(id), frame: id => api().browserFrame(id), stop: id => api().stopBrowser(id) }
export function BrowserButton({ conversationId }: { conversationId: string }) {
  const [available, setAvailable] = useState(false)
  const open = useApp(s => s.browserView === conversationId)
  useEffect(() => {
    let live = true; setAvailable(false)
    const read = () => void service.info(conversationId).then(info => { if (live) setAvailable(!!info) }).catch(() => {})
    read(); const timer = setInterval(read, 1500)
    return () => { live = false; clearInterval(timer) }
  }, [conversationId])
  if (!available) return null
  return <button className={'icon-btn' + (open ? ' on' : '')} aria-label={t('浏览器画面')} data-tip={t('浏览器画面')} onClick={() => useApp.getState().set({ browserView: open ? null : conversationId, fileView: null, page: null })}><Globe size={16} /></button>
}
export function BrowserPanel({ ownerId, exiting = false }: { ownerId: string; exiting?: boolean }) {
  const close = () => useApp.getState().set({ browserView: null })
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.overlay,.menu')) close() }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [])
  return <PreviewPane exiting={exiting} className="context-card browser-panel" label={t('浏览器')}><div className="panel-head"><strong>{t('浏览器')}</strong><span className="spacer" /><button className="icon-btn" aria-label={t('收起浏览器画面')} onClick={close}><PanelRightClose size={16} /></button></div><div className="panel-body"><BrowserView ownerId={ownerId} service={service} /></div></PreviewPane>
}
