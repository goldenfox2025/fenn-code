import { useRef, type ReactNode } from 'react'
import { usePaneViewport } from './usePaneViewport'
import { paneStyle, ResizeHandle, usePaneWidth, usePanelSqueezed } from './ResizeHandle'

/** Published pages and local files share the same inset, clipped preview surface. */
export function PreviewPane({ children, className = '', expanded = false, hidden = false, exiting = false, compact = false, label, layout = 'preview' }: { children: ReactNode; className?: string; expanded?: boolean; hidden?: boolean; exiting?: boolean; compact?: boolean; label?: string; layout?: 'preview' | 'thread' }) {
  const width = usePaneWidth('panel')
  const floating = usePanelSqueezed()
  const ref = useRef<HTMLElement>(null)
  usePaneViewport(ref, !hidden)
  return (
    <aside ref={ref} hidden={hidden} inert={hidden || exiting} aria-hidden={exiting || undefined} data-exiting={exiting || undefined} aria-label={label} className={hidden ? 'page-panel-cache' : `${layout === 'thread' ? 'panel' : 'page-panel'}${width && !expanded && !compact ? ' sized' : ''}${expanded ? ' maximized' : floating ? ' floating' : ''} ${className}`} style={expanded || compact ? undefined : paneStyle('panel', width)}>
      {!floating && !expanded && !compact && <ResizeHandle pane="panel" edge="left" />}
      <div className="pane-viewport">{children}</div>
    </aside>
  )
}
