import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'

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
  /** A key (shown muted on the right) that picks this item while the menu is open, as in Claude's model menu. */
  shortcut?: string
  /** Muted text on the right, e.g. the current value of a submenu. */
  hint?: string
  /** Opens beside the menu on hover, click or →. */
  submenu?: MenuItem[]
}

/** The button whose menu item was chosen last: a dialog that item opens returns focus there. */
let lastAnchor: HTMLElement | null = null
export const lastMenuAnchor = () => lastAnchor

const actionable = (it: MenuItem) => !it.separator && !it.heading && !it.disabled && !it.info
const inAnyMenu = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('.menu')

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
  matchWidth,
  compact,
  onPicked,
  parentFocus
}: {
  anchor: HTMLElement
  /** Where the anchor was when the menu opened, used if the anchor has been redrawn away since. */
  rect?: DOMRect
  items: MenuItem[]
  onClose: () => void
  align?: 'left' | 'right'
  placement?: 'below' | 'above' | 'side' | 'auto'
  /** At least as wide as the anchor (form dropdowns). */
  matchWidth?: boolean
  /** Claude's model-menu look: narrow, one line per item. */
  compact?: boolean
  /** A submenu: closes the whole menu once something is chosen. */
  onPicked?: () => void
  /** A submenu: where ← and Esc return focus. */
  parentFocus?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const anchor = liveAnchor(opener) ?? opener
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number; maxHeight?: number }>({ left: -9999, top: -9999 })
  const [active, setActive] = useState(() => {
    const sel = items.findIndex((it) => it.checked && actionable(it))
    return sel >= 0 ? sel : items.findIndex(actionable)
  })
  const hasChecks = items.some((it) => it.checked !== undefined || it.shortcut || it.submenu)
  const [sub, setSub] = useState<{ index: number; el: HTMLElement } | null>(null)
  const subTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(subTimer.current), [])

  useLayoutEffect(() => {
    const place = () => {
      const live = liveAnchor(opener)
      let r = live?.getBoundingClientRect()
      // A detached element measures as 0×0 at the window corner; never place a menu there.
      if (!r || (!r.width && !r.height)) r = openRect
      if (!r) return onClose()
      const element = ref.current!
      // Measure natural dimensions without the old viewport's position or
      // height limit. Restore the DOM styles before React applies the new ones.
      const previousLeft = element.style.left
      const previousMaxHeight = element.style.maxHeight
      element.style.left = '0px'
      element.style.maxHeight = ''
      const m = element.getBoundingClientRect()
      element.style.left = previousLeft
      element.style.maxHeight = previousMaxHeight
      const width = Math.max(m.width, matchWidth ? r.width : 0)
      if (placement === 'side') {
        // Beside the item it opened from, flipping to the left edge when the right has no room.
        let sideLeft = r.right + 6
        if (sideLeft + width > window.innerWidth - 8) sideLeft = Math.max(8, r.left - width - 6)
        const maxHeight = Math.min(m.height, window.innerHeight - 16)
        const sideTop = Math.max(8, Math.min(r.top - 5, window.innerHeight - maxHeight - 8))
        setPos({ left: sideLeft, top: sideTop, maxHeight })
        return
      }
      let left = align === 'right' ? r.right - width : r.left
      const gap = 8
      const room = { above: Math.max(0, r.top - gap - 8), below: Math.max(0, window.innerHeight - r.bottom - gap - 8) }
      // 'auto': wherever the whole menu fits, below first (the composer in the
      // middle of the home page opens down, at the bottom of a chat up).
      const preferred = placement === 'auto' ? (room.below >= m.height || room.below >= room.above ? 'below' : 'above') : placement
      const other = preferred === 'above' ? 'below' : 'above'
      // Preserve the preferred side when it can show a useful slice of a long
      // menu. Shrink and scroll it instead of clamping it across its opener.
      const side = room[preferred] < Math.min(m.height, 160) && room[other] > room[preferred] ? other : preferred
      const maxHeight = Math.min(m.height, room[side])
      const top = side === 'above' ? r.top - maxHeight - gap : r.bottom + gap
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
      setPos({ left, top, maxHeight, minWidth: matchWidth ? r.width : undefined })
    }
    place()
    ref.current!.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
    // A menu whose items change while open (models arriving) is placed again.
  }, [opener, openRect, align, placement, matchWidth, items.length])

  useEffect(() => {
    const menu = ref.current
    const item = menu?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!menu || !item) return
    // scrollIntoView can scroll the document and ancestors as well as the menu.
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < menu.scrollTop) menu.scrollTop = top
    else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight
  }, [active])

  // The control that opened the menu says so; its tooltip stays hidden meanwhile.
  useEffect(() => {
    const was = anchor.getAttribute('aria-expanded')
    if (!anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-haspopup', 'menu')
    anchor.setAttribute('aria-expanded', 'true')
    return () => (was === null ? anchor.removeAttribute('aria-expanded') : anchor.setAttribute('aria-expanded', was))
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      // A click in this menu's own submenu (another .menu) isn't outside it.
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node) && !inAnyMenu(e.target)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [anchor, onClose])

  const openSub = (i: number, focus = false) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)
    if (!el || !items[i]?.submenu) return
    setSub({ index: i, el })
    if (focus) requestAnimationFrame(() => document.querySelector<HTMLElement>('.menu.is-sub')?.focus({ preventScroll: true }))
  }
  const choose = (it: MenuItem, i = items.indexOf(it)) => {
    if (!actionable(it)) return
    if (it.submenu) return openSub(i, true)
    onClose()
    onPicked?.()
    const back = liveAnchor(opener) ?? anchor
    if (!onPicked) back.focus()
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
    if (e.target !== e.currentTarget) return
    const byKey = items.findIndex((it) => it.shortcut === e.key && actionable(it))
    if (byKey >= 0) {
      e.preventDefault()
      return choose(items[byKey], byKey)
    }
    if (e.key === 'ArrowRight' && items[active]?.submenu) openSub(active, true)
    else if (e.key === 'ArrowLeft' && parentFocus) {
      onClose()
      parentFocus()
    } else if (e.key === 'ArrowDown') move(active, 1)
    else if (e.key === 'ArrowUp') move(active < 0 ? 0 : active, -1)
    else if (e.key === 'Home') move(-1, 1)
    else if (e.key === 'End') move(0, -1)
    else if (e.key === 'Enter' || e.key === ' ') items[active] && choose(items[active])
    else if (e.key === 'Escape' || e.key === 'Tab') {
      onClose()
      if (parentFocus) parentFocus()
      else (liveAnchor(opener) ?? anchor).focus()
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
    <div className={'menu' + (compact ? ' compact' : '') + (parentFocus ? ' is-sub' : '')} role="menu" tabIndex={-1} ref={ref} style={pos} onKeyDown={onKey}>
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
            aria-haspopup={it.submenu ? 'menu' : undefined}
            aria-expanded={it.submenu ? sub?.index === i : undefined}
            aria-keyshortcuts={it.shortcut}
            tabIndex={-1}
            disabled={it.disabled || it.info}
            className={'menu-item' + (it.info ? ' info' : '') + (it.danger ? ' danger' : '') + (i === active || sub?.index === i ? ' active' : '')}
            onMouseEnter={() => {
              if (actionable(it)) setActive(i)
              clearTimeout(subTimer.current)
              // A short pause, so moving the pointer diagonally into an open submenu doesn't close it.
              subTimer.current = setTimeout(() => (it.submenu ? openSub(i) : setSub(null)), it.submenu ? 80 : 220)
            }}
            onClick={() => choose(it, i)}
          >
            {it.icon}
            <span className="menu-text">
              {it.label}
              {it.sub && <span className="sub">{it.sub}</span>}
            </span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {hasChecks && (
              <span className="menu-check">
                {it.submenu ? <ChevronRight size={15} /> : it.checked ? <Check size={15} /> : it.shortcut ? <span className="menu-key">{it.shortcut}</span> : null}
              </span>
            )}
          </button>
        )
      )}
      {sub && items[sub.index]?.submenu && (
        <Menu
          anchor={sub.el}
          items={items[sub.index].submenu!}
          placement="side"
          compact={compact}
          onClose={() => setSub(null)}
          onPicked={() => {
            onClose()
            onPicked?.()
            ;(liveAnchor(opener) ?? anchor).focus()
          }}
          parentFocus={() => {
            ref.current?.focus({ preventScroll: true })
            setActive(sub.index)
          }}
        />
      )}
    </div>,
    document.body
  )
}

/** Hook: const [menu, open] = useMenu(); <button onClick={e => open(e.currentTarget, items)}> {menu} */
export function useMenu(opts: { align?: 'left' | 'right'; placement?: 'below' | 'above' | 'auto'; matchWidth?: boolean; compact?: boolean } = {}) {
  const [state, setState] = useState<{ anchor: HTMLElement; rect: DOMRect; items: MenuItem[] } | null>(null)
  const node = state ? <Menu anchor={state.anchor} rect={state.rect} items={state.items} onClose={() => setState(null)} {...opts} /> : null
  return [
    node,
    (anchor: HTMLElement, items: MenuItem[]) =>
      setState((s) => (s?.anchor === anchor ? null : { anchor, rect: anchor.getBoundingClientRect(), items })),
    /** Replaces the items of the open menu (e.g. when its numbers arrive); does nothing when closed. */
    (items: MenuItem[]) => setState((s) => s && { ...s, items })
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
        data-tip={title}
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
