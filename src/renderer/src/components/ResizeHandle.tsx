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
    const { min } = PANE_LIMITS[pane]
    // The conversation column keeps room to read.
    const center = [...document.querySelectorAll('.center, .main')].find((el) => el.getClientRects().length && !target.contains(el) && !el.contains(target))
    const room = center ? center.getBoundingClientRect().width - MAIN_MIN : 0
    const max = Math.max(min, Math.min(PANE_LIMITS[pane].max, start + Math.max(0, room)))
    let raw = start
    const prop = pane === 'sidebar' ? '--sidebar-w' : '--panel-w'
    onResize?.()
    handle.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      raw = edge === 'right' ? start + dx : start - dx
      target.style.setProperty(prop, `${Math.min(max, Math.max(min, raw))}px`)
      target.classList.add('sized')
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      document.body.classList.remove('resizing')
      setDragging(false)
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
      aria-label={t('拖动调整宽度，双击恢复默认')}
      onPointerDown={onPointerDown}
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
