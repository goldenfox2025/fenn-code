import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { t } from '../i18n'
import { imeComposing } from '../util'
import { usePaneViewport } from './usePaneViewport'
import { paneStyle, ResizeHandle, usePaneWidth, usePanelSqueezed } from './ResizeHandle'

/** Published pages and local files share the same inset, clipped preview surface. */
export function PreviewPane({ children, className = '', expanded = false, onCollapse, hidden = false, exiting = false, compact = false, label, layout = 'preview' }: { children: ReactNode; className?: string; expanded?: boolean; onCollapse?: () => void; hidden?: boolean; exiting?: boolean; compact?: boolean; label?: string; layout?: 'preview' | 'thread' }) {
  const width = usePaneWidth('panel')
  const floating = usePanelSqueezed()
  const ref = useRef<HTMLElement>(null)
  usePaneViewport(ref, !hidden)
  const covering = expanded && !hidden && !exiting
  useLayoutEffect(() => {
    const pane = ref.current
    if (!covering || !pane) return
    const covered = [...(pane.parentElement?.children ?? [])].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== pane)
      .map(el => ({ el, inert: el.inert, hidden: el.getAttribute('aria-hidden') }))
    for (const { el } of covered) { el.inert = true; el.setAttribute('aria-hidden', 'true') }
    return () => {
      for (const { el, inert, hidden } of covered) {
        el.inert = inert
        if (hidden === null) el.removeAttribute('aria-hidden')
        else el.setAttribute('aria-hidden', hidden)
      }
    }
  }, [covering])
  useEffect(() => {
    if (!covering || !onCollapse) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !imeComposing(event) && !document.querySelector('.menu,.overlay,.file-full')) onCollapse()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [covering, onCollapse])
  return (
    <aside ref={ref} hidden={hidden} inert={hidden || exiting} aria-hidden={exiting || undefined} data-exiting={exiting || undefined} aria-label={label} className={hidden ? 'page-panel-cache' : `${layout === 'thread' ? 'panel' : 'page-panel'}${width && !expanded && !compact ? ' sized' : ''}${expanded ? ' maximized' : floating ? ' floating' : ''} ${className}`} style={expanded || compact ? undefined : paneStyle('panel', width)}>
      {!floating && !expanded && !compact && <ResizeHandle pane="panel" edge="left" />}
      <div className="pane-viewport">{children}</div>
    </aside>
  )
}

/** Projects and ordinary conversations expose the same pane size control. */
export function PaneSizeButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const label = expanded ? t('退出全屏') : t('全屏')
  return <button className="icon-btn" data-tip={label} aria-label={label} onClick={onToggle}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
}
