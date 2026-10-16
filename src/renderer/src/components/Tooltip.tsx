import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The app's one tooltip, in Claude's style: elements say `data-tip="…"` (never
 * the native `title`, whose boxy system tooltip gets clipped). It opens after a
 * short pause on hover or on keyboard focus, at once while moving between tips,
 * and is placed above the element, flipped below or shifted sideways so it
 * always stays inside the window.
 */
const DELAY = 400
const WARM_MS = 300
const GAP = 6
const EDGE = 8
// A control whose menu is open shows the menu, not its tooltip.
const expanded = (el: Element) => !!el.closest('[aria-haspopup][aria-expanded="true"]')

interface Tip {
  text: string
  el: Element
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const bubble = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let current: Element | null = null
    let shown = false
    let lastHidden = 0
    const hide = () => {
      clearTimeout(timer)
      current = null
      if (shown) lastHidden = Date.now()
      shown = false
      setTip(null)
    }
    const open = (el: Element) => {
      if (el === current) return
      if (expanded(el)) return hide()
      hide()
      current = el
      const warm = Date.now() - lastHidden < WARM_MS
      timer = setTimeout(() => {
        const text = el.getAttribute('data-tip')
        if (!el.isConnected || !text || current !== el || expanded(el)) return
        shown = true
        setTip({ text, el })
      }, warm ? 0 : DELAY)
    }
    const tipOf = (t: EventTarget | null) => (t instanceof Element ? t.closest('[data-tip]') : null)
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const el = tipOf(e.target)
      if (el && el.getAttribute('data-tip')) open(el)
      else if (current) hide()
    }
    const focus = (e: FocusEvent) => {
      const el = tipOf(e.target)
      if (el && el.getAttribute('data-tip') && (e.target as Element).matches(':focus-visible')) open(el)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && hide()
    const leaveWindow = (e: PointerEvent) => !e.relatedTarget && hide()
    document.addEventListener('pointerover', over)
    document.addEventListener('pointerout', leaveWindow)
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', hide)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerover', over)
      document.removeEventListener('pointerout', leaveWindow)
      document.removeEventListener('focusin', focus)
      document.removeEventListener('focusout', hide)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // An icon-only control still needs a name for screen readers: its tip.
  useEffect(() => {
    let frame = 0
    const name = () => {
      frame = 0
      for (const el of document.querySelectorAll('[data-tip]:not([aria-label])'))
        if (!el.textContent?.trim()) el.setAttribute('aria-label', el.getAttribute('data-tip') ?? '')
    }
    const watch = new MutationObserver(() => (frame ||= requestAnimationFrame(name)))
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tip'] })
    name()
    return () => {
      watch.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [])

  // The text can change while shown (a timer, a status).
  useEffect(() => {
    if (!tip) return
    const watch = new MutationObserver(() => {
      const text = tip.el.getAttribute('data-tip')
      if (!tip.el.isConnected || !text || expanded(tip.el)) setTip(null)
      else if (text !== tip.text) setTip({ ...tip, text })
    })
    watch.observe(tip.el, { attributes: true, attributeFilter: ['data-tip', 'aria-expanded'] })
    return () => watch.disconnect()
  }, [tip])

  useLayoutEffect(() => {
    if (!tip || !bubble.current) return setPos(null)
    const r = tip.el.getBoundingClientRect()
    const b = bubble.current.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let below = r.top - GAP - b.height < EDGE
    if (below && r.bottom + GAP + b.height > vh - EDGE) below = r.top > vh - r.bottom
    const top = below ? r.bottom + GAP : r.top - GAP - b.height
    const left = Math.min(Math.max(r.left + r.width / 2 - b.width / 2, EDGE), vw - EDGE - b.width)
    setPos({ left, top: Math.min(Math.max(top, EDGE), vh - EDGE - b.height), below })
  }, [tip])

  if (!tip) return null
  // On <body>, above popovers that are portaled there too.
  return createPortal(
    <div
      ref={bubble}
      role="tooltip"
      className={'tooltip' + (pos ? ' on' : '') + (pos?.below ? ' below' : '')}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
    >
      {tip.text}
    </div>,
    document.body
  )
}
