import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { t } from '../i18n'
import { lastMenuAnchor } from './Menu'
import { imeComposing } from '../util'

/*
 * Every dialog and in-dialog form is a layer. Esc closes only the topmost
 * one, and keyboard focus stays inside the topmost dialog, like Claude.
 */
interface Layer {
  close: () => void
  root?: HTMLElement | null
}
const layers: Layer[] = []

document.addEventListener('keydown', (e) => {
  // Menus and inline editors handle their own Esc and stop it before here.
  if (e.key !== 'Escape' || e.defaultPrevented || !layers.length || imeComposing(e)) return
  e.preventDefault()
  layers[layers.length - 1].close()
})

/** Registers a layer while mounted; Esc closes the newest layer first. */
export function useLayer(close: () => void, root?: React.RefObject<HTMLElement | null>): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    const layer: Layer = { close: () => closeRef.current(), root: root?.current }
    layers.push(layer)
    return () => {
      const i = layers.indexOf(layer)
      if (i >= 0) layers.splice(i, 1)
    }
  }, [root])
}

/** For forms shown in place (not their own dialog): Esc closes them first. */
export function EscLayer({ onClose }: { onClose: () => void }) {
  useLayer(onClose)
  return null
}

/**
 * Gives focus back to what opened a dialog. A list row may have been
 * redrawn meanwhile; a `data-focus-key` finds the same button again.
 */
export function restoreFocus(opener: HTMLElement | null): void {
  if (!opener || opener === document.body) return
  if (opener.isConnected) return opener.focus()
  const key = opener.dataset.focusKey
  if (key) document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)?.focus()
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}

/**
 * The dimmed backdrop of every dialog. Opening moves focus inside (the first
 * text field, else `initialFocus`, else the dialog); Tab cycles within it; a
 * click outside or Esc closes it; closing returns focus to what opened it.
 */
export function Overlay({ onClose, children, initialFocus, label, opener: suppliedOpener }: { onClose: () => void; children: ReactNode; initialFocus?: string; label?: string; opener?: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const headingId = useId()
  useLayer(onClose, ref)
  useEffect(() => {
    // A menu item that opened this may have taken its button away with the menu.
    const active = document.activeElement as HTMLElement | null
    const opener = suppliedOpener ?? (active && active !== document.body ? active : lastMenuAnchor())
    const root = ref.current!
    const heading = root.querySelector<HTMLElement>('h1, h2, h3')
    if (!label && heading) {
      if (!heading.id) heading.id = headingId
      root.setAttribute('aria-labelledby', heading.id)
    }
    const first =
      (initialFocus && root.querySelector<HTMLElement>(initialFocus)) ||
      root.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea:not([disabled])') ||
      root.querySelector<HTMLElement>('.modal')
    first?.focus()
    // Only the newest dialog keeps focus (a form layer inside it has no root of its own).
    const top = () => [...layers].reverse().find((l) => l.root)?.root === root
    // Focus that wanders outside (a click on the backdrop page, a stray Tab) comes back.
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement
      if (!top() || root.contains(el) || el.closest('.menu, .toasts')) return
      ;(focusables(root)[0] ?? root.querySelector<HTMLElement>('.modal'))?.focus()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      restoreFocus(opener)
    }
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    // A text editor inside keeps its Tab.
    if (e.key !== 'Tab' || e.defaultPrevented) return
    const items = focusables(ref.current!)
    if (!items.length) return e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1
    e.preventDefault()
    items[next].focus()
  }
  return (
    <div
      className="overlay"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {children}
    </div>
  )
}

// ---- confirm ---------------------------------------------------------------

interface ConfirmRequest {
  message: string
  title?: string
  ok?: string
  danger?: boolean
  /** Shown in a code block under the message, e.g. the command about to run. */
  code?: string
  /** Ask for a line of text instead of a yes/no; done gets the text through `value`. */
  input?: { value: string; placeholder?: string }
  done: (ok: boolean, value?: string) => void
}
let showConfirm: ((r: ConfirmRequest) => void) | null = null

/** The app's own confirm dialog, themed like every other dialog. */
export function confirmDialog(message: string, opts: { title?: string; ok?: string; danger?: boolean; code?: string } = {}): Promise<boolean> {
  return new Promise((done) => {
    if (!showConfirm) return done(window.confirm(message))
    showConfirm({ message, danger: true, ...opts, done })
  })
}

/** The app's own one-line text prompt (e.g. rename). Resolves to the trimmed text, or null if cancelled or empty. */
export function promptDialog(title: string, value: string, opts: { ok?: string; placeholder?: string } = {}): Promise<string | null> {
  return new Promise((done) => {
    if (!showConfirm) return done(window.prompt(title, value)?.trim() || null)
    showConfirm({
      message: '',
      title,
      ok: opts.ok ?? t('保存'),
      input: { value, placeholder: opts.placeholder },
      done: (ok, v) => done(ok && v?.trim() ? v.trim() : null)
    })
  })
}

/** Mounted once in App; shows confirmDialog() and promptDialog() requests. */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null)
  const [text, setText] = useState('')
  useEffect(() => {
    showConfirm = (r) => {
      setText(r.input?.value ?? '')
      setReq(r)
    }
    return () => {
      showConfirm = null
    }
  }, [])
  if (!req) return null
  const finish = (ok: boolean) => {
    setReq(null)
    req.done(ok, text)
  }
  return (
    <Overlay label={req.title || req.message} onClose={() => finish(false)} initialFocus={req.input ? '.modal.confirm input' : '.confirm-cancel'}>
      <div className={'modal confirm' + (req.code ? ' has-code' : '')} tabIndex={-1}>
        {req.title && <h2>{req.title}</h2>}
        {req.message && <p className="confirm-text">{req.message}</p>}
        {req.code && <pre className="confirm-code">{req.code}</pre>}
        {req.input && (
          <input
            className="input"
            aria-label={req.title || req.message}
            value={text}
            placeholder={req.input.placeholder}
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => e.key === 'Enter' && !imeComposing(e) && finish(true)}
          />
        )}
        <div className="modal-actions">
          <button className="btn confirm-cancel" onClick={() => finish(false)}>
            {t('取消')}
          </button>
          <button className={'btn ' + (req.danger ? 'danger-solid' : 'primary')} onClick={() => finish(true)}>
            {req.ok ?? t('删除')}
          </button>
        </div>
      </div>
    </Overlay>
  )
}
