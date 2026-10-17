import { useEffect, useState } from 'react'
import { t } from '../i18n'

/** Widths the user dragged, remembered in this window (cleared by a double-click on the handle). */
export type Pane = 'sidebar' | 'panel'

export const PANE_LIMITS: Record<Pane, { min: number; max: number }> = {
  sidebar: { min: 220, max: 440 },
  panel: { min: 360, max: 1200 }
}
/** The conversation column never gets narrower than this while a pane is dragged. */
const MAIN_MIN = 420
/** Dragging the sidebar this far below its minimum puts it away. */
const COLLAPSE_SLACK = 64

const key = (pane: Pane) => `oc-width-${pane}`
const listeners = new Set<() => void>()

export function storedWidth(pane: Pane): number | undefined {
  try {
    const v = Number(localStorage.getItem(key(pane)))
    return v > 0 ? v : undefined
  } catch {
    return undefined
  }
}

function store(pane: Pane, width: number | undefined) {
  try {
    if (width === undefined) localStorage.removeItem(key(pane))
    else localStorage.setItem(key(pane), String(Math.round(width)))
  } catch {
    // Storage may be unavailable; the width still applies until the window closes.
  }
  for (const fn of listeners) fn()
}

/** The width the user gave a pane, if any (undefined: the layout's own default). */
export function usePaneWidth(pane: Pane): number | undefined {
  const [w, setW] = useState(() => storedWidth(pane))
  useEffect(() => {
    const fn = () => setW(storedWidth(pane))
    listeners.add(fn)
    return () => void listeners.delete(fn)
  }, [pane])
  return w
}

/** How narrow and how wide a pane may be now: the conversation column keeps room to read. */
function bounds(pane: Pane, target: HTMLElement): { min: number; max: number } {
  const { min } = PANE_LIMITS[pane]
  const start = target.getBoundingClientRect().width
  const center = [...document.querySelectorAll('.center, .main')].find((el) => el.getClientRects().length && !target.contains(el) && !el.contains(target))
  const room = center ? center.getBoundingClientRect().width - MAIN_MIN : 0
  return { min, max: Math.max(min, Math.min(PANE_LIMITS[pane].max, start + Math.max(0, room))) }
}

const KEY_STEP = 16

/**
 * A drag handle on a pane's inner edge, as in Claude: col-resize cursor, a thin
 * line on hover, double-click for the default width. `edge` is the side of the
 * pane the handle sits on.
 */
export function ResizeHandle({ pane, edge, onCollapse, onResize }: { pane: Pane; edge: 'left' | 'right'; onCollapse?: () => void; onResize?: () => void }) {
  const [dragging, setDragging] = useState(false)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const target = handle.parentElement
    if (!target) return
    const start = target.getBoundingClientRect().width
    const x0 = e.clientX
    const { min, max } = bounds(pane, target)
    let raw = start
    const prop = pane === 'sidebar' ? '--sidebar-w' : '--panel-w'
    onResize?.()
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      raw = edge === 'right' ? start + dx : start - dx
      const w = Math.min(max, Math.max(min, raw))
      target.style.setProperty(prop, `${w}px`)
      target.classList.add('sized')
      // The caps follow the drag too, or the pane could only grow once the button is let go.
      if (pane === 'sidebar') {
        dragSidebar = w
        fitPanes(true)
      }
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      setDragging(false)
      dragSidebar = undefined
      if (onCollapse && raw < min - COLLAPSE_SLACK) {
        // Put away at the width it had; the pane opens again as it was.
        const before = storedWidth(pane)
        if (before) target.style.setProperty(prop, `${before}px`)
        else {
          target.style.removeProperty(prop)
          target.classList.remove('sized')
        }
        onCollapse()
        return
      }
      if (raw !== start) store(pane, Math.min(max, Math.max(min, raw)))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  return (
    <div
      className={`resize-handle edge-${edge}` + (dragging ? ' active' : '')}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('拖动或用方向键调整宽度，双击或按 Home 恢复默认')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        // Arrow keys move the edge (Shift for bigger steps); Home goes back to the default.
        const target = e.currentTarget.parentElement
        if (!target) return
        if (e.key === 'Home') {
          e.preventDefault()
          target.style.removeProperty(pane === 'sidebar' ? '--sidebar-w' : '--panel-w')
          target.classList.remove('sized')
          return store(pane, undefined)
        }
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const { min, max } = bounds(pane, target)
        const outward = (e.key === 'ArrowRight') === (edge === 'right')
        const step = (e.shiftKey ? 4 : 1) * KEY_STEP * (outward ? 1 : -1)
        onResize?.()
        const next = Math.min(max, Math.max(min, target.getBoundingClientRect().width + step))
        target.style.setProperty(pane === 'sidebar' ? '--sidebar-w' : '--panel-w', `${next}px`)
        target.classList.add('sized')
        store(pane, next)
      }}
      onDoubleClick={(e) => {
        const target = e.currentTarget.parentElement
        target?.style.removeProperty(pane === 'sidebar' ? '--sidebar-w' : '--panel-w')
        target?.classList.remove('sized')
        store(pane, undefined)
      }}
    />
  )
}

/** Inline style for a pane the user resized. */
export function paneStyle(pane: Pane, width: number | undefined): React.CSSProperties | undefined {
  return width ? ({ [pane === 'sidebar' ? '--sidebar-w' : '--panel-w']: `${width}px` } as React.CSSProperties) : undefined
}

/** Room the conversation column always keeps, and the panel's own minimum and right margin. */
const PANEL_MARGIN = 16
const SIDEBAR_DEFAULT = 284
let squeezed = false
/** The sidebar's width while its edge is being dragged (not stored yet). */
let dragSidebar: number | undefined
const squeezeListeners = new Set<() => void>()

/**
 * Fits the panes to the window as it is now, without touching what the user
 * chose: the sidebar keeps its width (only a window too narrow for it and the
 * conversation trims it); the thread panel gives way down to its minimum and,
 * when even that leaves the conversation too little room, folds away. Nothing
 * jumps: the sidebar never changes because the panel came or went, and in an
 * ordinary chat, which has no panel, nothing is reserved for one. Sets
 * --sidebar-cap and --panel-cap on the root.
 */
export function fitPanes(sidebarOpen: boolean): void {
  const w = window.innerWidth
  const s = dragSidebar ?? storedWidth('sidebar') ?? SIDEBAR_DEFAULT
  const sidebarCap = sidebarOpen ? Math.max(PANE_LIMITS.sidebar.min, Math.min(s, w - MAIN_MIN)) : s
  const panelCap = w - MAIN_MIN - PANEL_MARGIN - (sidebarOpen ? sidebarCap : 0)
  const squeeze = panelCap < PANE_LIMITS.panel.min
  const root = document.documentElement.style
  root.setProperty('--sidebar-cap', `${sidebarCap}px`)
  root.setProperty('--panel-cap', `${Math.max(PANE_LIMITS.panel.min, panelCap)}px`)
  if (squeeze !== squeezed) {
    squeezed = squeeze
    for (const fn of squeezeListeners) fn()
  }
}

/** Keeps the panes fitted as the window, the sidebar or a stored width changes. */
export function usePaneFit(sidebarOpen: boolean): void {
  useEffect(() => {
    const fit = () => fitPanes(sidebarOpen)
    fit()
    window.addEventListener('resize', fit)
    listeners.add(fit)
    return () => {
      window.removeEventListener('resize', fit)
      listeners.delete(fit)
    }
  }, [sidebarOpen])
}

/** The window is too narrow for the thread panel beside the conversation. */
export function usePanelSqueezed(): boolean {
  const [v, setV] = useState(squeezed)
  useEffect(() => {
    const fn = () => setV(squeezed)
    squeezeListeners.add(fn)
    fn()
    return () => void squeezeListeners.delete(fn)
  }, [])
  return v
}
