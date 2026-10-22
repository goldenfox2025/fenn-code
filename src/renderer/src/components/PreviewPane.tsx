import type { ReactNode } from 'react'
import { paneStyle, ResizeHandle, usePaneWidth, usePanelSqueezed } from './ResizeHandle'

/** Published pages and local files share the same inset, clipped preview surface. */
export function PreviewPane({ children, className = '', expanded = false, hidden = false }: { children: ReactNode; className?: string; expanded?: boolean; hidden?: boolean }) {
  const width = usePaneWidth('panel')
  const floating = usePanelSqueezed()
  return (
    <aside hidden={hidden} inert={hidden} className={hidden ? 'page-panel-cache' : `page-panel${width ? ' sized' : ''}${expanded ? ' maximized' : floating ? ' floating' : ''} ${className}`} style={paneStyle('panel', width)}>
      {!floating && !expanded && <ResizeHandle pane="panel" edge="left" />}
      {children}
    </aside>
  )
}
