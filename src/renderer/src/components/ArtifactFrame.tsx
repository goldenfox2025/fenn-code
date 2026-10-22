import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { WorkingMark } from './WorkingMark'
import { EmbeddedSelect } from './EmbeddedSelect'

// Shared by every frame in this renderer. A new app build/window still gets
// fresh display fixes, without defeating caching every time a preview opens.
const DISPLAY_SESSION = Date.now()
const sizes = new Map<string, { height: number; padded: boolean }>()

/** Same isolated renderer in a reply and the larger preview pane. */
export function ArtifactFrame({ id, version, title, inline = false, active = true, reload = 0 }: { id: string; version: number; title: string; inline?: boolean; active?: boolean; reload?: number }) {
  const key = `${id}:${version}`
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [showLoading, setShowLoading] = useState(false)
  const [since] = useState(Date.now)
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(() => sizes.get(key)?.height ?? 160)
  const [padded, setPadded] = useState(() => sizes.get(key)?.padded ?? false)
  useEffect(() => {
    if (loaded || failed) return
    // Local cached documents usually paint within one frame. Avoid flashing
    // a progress indicator for that, but still explain an actual slow load.
    const timer = setTimeout(() => setShowLoading(true), 120)
    return () => clearTimeout(timer)
  }, [loaded, failed])
  const sendTheme = () => {
    const root = document.documentElement
    const css = getComputedStyle(root)
    const palette = Object.fromEntries(['text', 'text-2', 'text-3', 'bg', 'bg-elevated', 'border', 'accent', 'accent-fg'].map((key) => [key, css.getPropertyValue(`--${key}`).trim()]))
    ref.current?.contentWindow?.postMessage({ type: 'fenn:ui-theme', scheme: root.dataset.theme, palette, selectMenu: true }, '*')
  }
  useEffect(() => {
    if (!active) return
    sendTheme()
    const resize = (e: MessageEvent) => {
      if (!inline || e.source !== ref.current?.contentWindow) return
      if (e.data?.type === 'fenn:ui-display') {
        setPadded(e.data.inset === 6)
        return
      }
      if (e.data?.type !== 'fenn:ui-size') return
      const next = e.data.height
      if (typeof next === 'number' && Number.isFinite(next)) {
        setHeight(Math.max(40, Math.min(12000, Math.ceil(next))))
      }
    }
    window.addEventListener('message', resize)
    const observer = new MutationObserver(sendTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { window.removeEventListener('message', resize); observer.disconnect() }
  }, [inline, active])
  useEffect(() => {
    if (!inline || !loaded) return
    sizes.delete(key)
    sizes.set(key, { height, padded })
    if (sizes.size > 64) sizes.delete(sizes.keys().next().value!)
  }, [key, inline, loaded, height, padded])
  return (
    <div hidden={!active} className={'artifact-surface' + (inline ? ' inline' : '') + (padded ? ' ui-padded' : '')}>
      {failed ? <div className="artifact-loading" role="status">{t('无法加载预览')}</div> : !loaded && showLoading && <div className="artifact-loading"><WorkingMark since={since} label={t('正在加载预览…')} /></div>}
      <iframe
        ref={ref}
        className="page-frame"
        title={title}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        src={`oc-page://page/${id}/${version}?display=${DISPLAY_SESSION}&reload=${reload}`}
        loading={inline ? 'lazy' : 'eager'}
        style={inline ? { height } : undefined}
        onLoad={() => { setLoaded(true); sendTheme() }}
        onError={() => setFailed(true)}
      />
      <EmbeddedSelect key={`${id}:${version}`} frame={ref} active={active} />
    </div>
  )
}
