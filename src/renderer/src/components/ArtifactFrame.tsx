import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { WorkingMark } from './WorkingMark'
import { EmbeddedSelect } from './EmbeddedSelect'

/** Same isolated renderer in a reply and the larger preview pane. */
export function ArtifactFrame({ id, version, title, inline = false }: { id: string; version: number; title: string; inline?: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [since] = useState(Date.now)
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(160)
  const [fluid, setFluid] = useState(false)
  const sendTheme = () => {
    const root = document.documentElement
    const css = getComputedStyle(root)
    const palette = Object.fromEntries(['text', 'text-2', 'text-3', 'bg', 'bg-elevated', 'border', 'accent', 'accent-fg'].map((key) => [key, css.getPropertyValue(`--${key}`).trim()]))
    ref.current?.contentWindow?.postMessage({ type: 'fenn:ui-theme', scheme: root.dataset.theme, palette, selectMenu: true }, '*')
  }
  useEffect(() => {
    const resize = (e: MessageEvent) => {
      if (!inline || e.source !== ref.current?.contentWindow || e.data?.type !== 'fenn:ui-size') return
      const next = e.data.height
      if (typeof next === 'number' && Number.isFinite(next)) {
        setFluid(true)
        setHeight(Math.max(40, Math.min(12000, Math.ceil(next))))
      }
    }
    window.addEventListener('message', resize)
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { window.removeEventListener('message', resize); observer.disconnect() }
  }, [inline])
  return (
    <div className={'artifact-surface' + (inline ? ' inline' : '') + (fluid ? ' ui-padded' : '')}>
      {failed ? <div className="artifact-loading" role="status">{t('无法加载预览')}</div> : !loaded && <div className="artifact-loading"><WorkingMark since={since} label={t('正在加载预览…')} /></div>}
      <iframe
        ref={ref}
        className="page-frame"
        title={title}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        src={`oc-page://page/${id}/${version}`}
        loading={inline ? 'lazy' : 'eager'}
        style={inline ? { height } : undefined}
        onLoad={() => { setLoaded(true); sendTheme() }}
        onError={() => setFailed(true)}
      />
      <EmbeddedSelect key={`${id}:${version}`} frame={ref} />
    </div>
  )
}
