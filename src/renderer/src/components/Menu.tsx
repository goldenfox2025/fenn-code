import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'

export interface MenuItem {
  label?: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  separator?: boolean
  heading?: string
  checked?: boolean
  /** A line of information, not a choice (shown at full strength, never clickable). */
  info?: boolean
}

/** The button whose menu item was chosen last: a dialog that item opens returns focus there. */
let lastAnchor: HTMLElement | null = null
export const lastMenuAnchor = () => lastAnchor

const actionable = (it: MenuItem) => !it.separator && !it.heading && !it.disabled && !it.info

/**
 * The app's one popover menu, used for every dropdown and "…" menu:
 * rounded popover, a check mark on the selected item, keyboard navigation
 * (↑ ↓ Home End Enter Esc, and typing a letter), light and dark themes.
 */
/**
 * The element a menu should sit next to. If the button it was opened from has
 * been redrawn (same data-focus-key), use the new one; if it is gone, null.
 */
function liveAnchor(anchor: HTMLElement): HTMLElement | null {
  if (anchor.isConnected) return anchor
  const key = anchor.dataset.focusKey
  return (key && document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)) || null
}

export function Menu({
  anchor: opener,
  rect: openRect,
  items,
  onClose,
  align = 'left',
  placement = 'below',
  matchWidth
}: {
  anchor: HTMLElement
  /** Where the anchor was when the menu opened, used if the anchor has been redrawn away since. */
  rect?: DOMRect
  items: MenuItem[]
  onClose: () => void
  align?: 'left' | 'right'
  placement?: 'below' | 'above'
  /** At least as wide as the anchor (form dropdowns). */
  matchWidth?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const anchor = liveAnchor(opener) ?? opener
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number }>({ left: -9999, top: -9999 })
  const [active, setActive] = useState(() => {
    const sel = items.findIndex((it) => it.checked && actionable(it))
    return sel >= 0 ? sel : items.findIndex(actionable)
  })
  const hasChecks = items.some((it) => it.checked !== undefined)

  useLayoutEffect(() => {
    const live = liveAnchor(opener)
    let r = live?.getBoundingClientRect()
    // A detached element measures as 0×0 at the window corner; never place a menu there.
    if (!r || (!r.width && !r.height)) r = openRect
    if (!r) return onClose()
    const m = ref.current!.getBoundingClientRect()
    const width = Math.max(m.width, matchWidth ? r.width : 0)
    let left = align === 'right' ? r.right - width : r.left
    let top = placement === 'above' ? r.top - m.height - 6 : r.bottom + 6
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    // Flip to the other side when it doesn't fit, then clamp inside the window.
    if (placement === 'below' && top + m.height > window.innerHeight - 8) top = r.top - m.height - 6
    if (placement === 'above' && top < 8) top = r.bottom + 6
    top = Math.max(8, Math.min(top, window.innerHeight - m.height - 8))
    setPos({ left, top, minWidth: matchWidth ? r.width : undefined })
    ref.current!.focus()
  }, [opener, openRect, align, placement, matchWidth])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [anchor, onClose])

  const choose = (it: MenuItem) => {
    if (!actionable(it)) return
    onClose()
    const back = liveAnchor(opener) ?? anchor
    back.focus()
    lastAnchor = back
    it.onClick?.()
  }
  const move = (from: number, step: number) => {
    for (let n = 1; n <= items.length; n++) {
      const i = (from + step * n + items.length * n) % items.length
      if (actionable(items[i])) return setActive(i)
    }
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') move(active, 1)
    else if (e.key === 'ArrowUp') move(active < 0 ? 0 : active, -1)
    else if (e.key === 'Home') move(-1, 1)
    else if (e.key === 'End') move(0, -1)
    else if (e.key === 'Enter' || e.key === ' ') items[active] && choose(items[active])
    else if (e.key === 'Escape' || e.key === 'Tab') {
      onClose()
      ;(liveAnchor(opener) ?? anchor).focus()
    } else if (e.key.length === 1) {
      // Jump to the next item starting with the typed letter.
      const k = e.key.toLowerCase()
      const n = items.length
      for (let s = 1; s <= n; s++) {
        const i = (active + s) % n
        const text = typeof items[i].label === 'string' ? (items[i].label as string) : ''
        if (actionable(items[i]) && text.toLowerCase().startsWith(k)) {
          setActive(i)
          break
        }
      }
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div className="menu" role="menu" tabIndex={-1} ref={ref} style={pos} onKeyDown={onKey}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : it.heading ? (
          <div key={i} className="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            data-index={i}
            role={it.checked !== undefined ? 'menuitemradio' : 'menuitem'}
            aria-checked={it.checked !== undefined ? it.checked : undefined}
            tabIndex={-1}
            disabled={it.disabled || it.info}
            className={'menu-item' + (it.info ? ' info' : '') + (it.danger ? ' danger' : '') + (i === active ? ' active' : '')}
            onMouseEnter={() => actionable(it) && setActive(i)}
            onClick={() => choose(it)}
          >
            {it.icon}
            <span className="menu-text">
              {it.label}
              {it.sub && <span className="sub">{it.sub}</span>}
            </span>
            {hasChecks && <span className="menu-check">{it.checked && <Check size={15} />}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  )
}

/** Hook: const [menu, open] = useMenu(); <button onClick={e => open(e.currentTarget, items)}> {menu} */
export function useMenu(opts: { align?: 'left' | 'right'; placement?: 'below' | 'above'; matchWidth?: boolean } = {}) {
  const [state, setState] = useState<{ anchor: HTMLElement; rect: DOMRect; items: MenuItem[] } | null>(null)
  const node = state ? <Menu anchor={state.anchor} rect={state.rect} items={state.items} onClose={() => setState(null)} {...opts} /> : null
  return [
    node,
    (anchor: HTMLElement, items: MenuItem[]) =>
      setState((s) => (s?.anchor === anchor ? null : { anchor, rect: anchor.getBoundingClientRect(), items }))
  ] as const
}

export interface DropdownOption<T extends string = string> {
  value: T
  label: ReactNode
  sub?: ReactNode
  icon?: ReactNode
}

/**
 * A select box built on Menu, so every choice in the app looks and behaves
 * the same. 'field' fills a form row; 'inline' is a compact button for
 * toolbars and the composer.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  variant = 'field',
  icon,
  align,
  placement,
  title,
  className
}: {
  value: T | undefined
  options: (DropdownOption<T> | { heading: string } | { separator: true })[]
  onChange: (value: T) => void
  placeholder?: ReactNode
  variant?: 'field' | 'inline'
  icon?: ReactNode
  align?: 'left' | 'right'
  placement?: 'below' | 'above'
  title?: string
  className?: string
}) {
  const [menu, open] = useMenu({ align, placement, matchWidth: variant === 'field' })
  const current = options.find((o): o is DropdownOption<T> => 'value' in o && o.value === value)
  const items: MenuItem[] = options.map((o) =>
    'value' in o
      ? { label: o.label, sub: o.sub, icon: o.icon, checked: o.value === value, onClick: () => onChange(o.value) }
      : o
  )
  return (
    <>
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        className={(variant === 'field' ? 'dropdown' : 'select-btn') + (className ? ' ' + className : '')}
        onClick={(e) => {
          e.stopPropagation()
          open(e.currentTarget, items)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            open(e.currentTarget, items)
          }
        }}
      >
        {icon ?? current?.icon}
        <span className="dropdown-value">{current?.label ?? <span className="muted">{placeholder}</span>}</span>
        <ChevronDown size={14} className="dropdown-chevron" />
      </button>
      {menu}
    </>
  )
}
