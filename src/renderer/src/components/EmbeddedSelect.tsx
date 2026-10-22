import { useEffect, useRef, useState, type RefObject } from 'react'
import { Menu, type MenuItem } from './Menu'

type Choice = { label: string; index: number; disabled: boolean; selected: boolean; group?: string }
type Picker = { id: number; anchor: HTMLElement; rect: DOMRect; options: Choice[] }

/** Use the app's menu outside the sandbox, so a short iframe cannot clip it. */
export function EmbeddedSelect({ frame, active = true }: { frame: RefObject<HTMLIFrameElement | null>; active?: boolean }) {
  const [picker, setPicker] = useState<Picker | null>(null)
  const current = useRef<Picker | null>(null)
  const finish = (index: number | null) => {
    const p = current.current
    if (!p) return
    current.current = null
    setPicker(null)
    frame.current?.contentWindow?.postMessage({ type: 'fenn:ui-select-result', id: p.id, index }, '*')
  }
  useEffect(() => {
    if (!active) { finish(null); return }
    const message = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.type !== 'fenn:ui-select') return
      const { id, rect, options } = e.data
      if (!Number.isSafeInteger(id) || !rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || !Array.isArray(options) || options.length > 2000) return
      const valid = options.every((o: Choice) => o && typeof o.label === 'string' && o.label.length <= 2000 && Number.isInteger(o.index) && typeof o.disabled === 'boolean' && typeof o.selected === 'boolean' && (o.group === undefined || typeof o.group === 'string'))
      if (!valid) return
      finish(null)
      const outer = frame.current!.getBoundingClientRect()
      const p: Picker = { id, anchor: document.createElement('span'), rect: new DOMRect(outer.left + rect.left, outer.top + rect.top, rect.width, rect.height), options }
      current.current = p
      setPicker(p)
    }
    const close = (e: Event) => {
      if ((e.target as Element | null)?.closest?.('.menu')) return
      finish(null)
    }
    window.addEventListener('message', message)
    // Moving the document invalidates the sandbox's recorded control bounds.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('message', message); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close) }
  }, [frame, active])
  if (!picker) return null
  const items: MenuItem[] = []
  let group: string | undefined
  for (const o of picker.options) {
    if (o.group && o.group !== group) items.push({ heading: o.group })
    group = o.group
    items.push({ label: o.label, disabled: o.disabled, checked: o.selected, onClick: () => finish(o.index) })
  }
  return <Menu anchor={picker.anchor} rect={picker.rect} items={items} matchWidth="exact" placement="auto" onClose={() => {
    setPicker(null)
    // Menu calls onClose before its chosen item's callback.
    queueMicrotask(() => { if (current.current === picker) finish(null) })
  }} />
}
