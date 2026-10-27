import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { restoreFocus, useLayer } from '../Modal'

export type FileViewport = Map<string, { top: number; left: number; start?: number; end?: number; direction?: 'forward' | 'backward' | 'none' }>

let active = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => active > 0
const notify = () => { for (const listener of listeners) listener() }
/** Responsive owners retain the source pane until an expanded file returns. */
export const useFileExpansionActive = () => useSyncExternalStore(subscribe, snapshot, snapshot)

/** A file occupies the main workspace, outside every animated/clipped pane. */
export function FileExpansion({ children, label, opener, onCollapse }: { children: ReactNode; label: string; opener: HTMLElement | null; onCollapse: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const workspace = document.querySelector<HTMLElement>('.main > .workspace')
  useLayer(onCollapse, ref)

  useLayoutEffect(() => {
    const root = ref.current
    if (!workspace || !root) return
    active++
    notify()
    const covered = new Map<HTMLElement, { inert: boolean; hidden: string | null }>()
    const cover = () => {
      for (const child of workspace.children) {
        if (!(child instanceof HTMLElement) || child === root || covered.has(child)) continue
        covered.set(child, { inert: child.inert, hidden: child.getAttribute('aria-hidden') })
        child.inert = true
        child.setAttribute('aria-hidden', 'true')
      }
    }
    cover()
    const observer = new MutationObserver(cover)
    observer.observe(workspace, { childList: true })
    ;(root.querySelector<HTMLElement>('.preview-editor') ?? root).focus({ preventScroll: true })
    return () => {
      observer.disconnect()
      for (const [child, previous] of covered) {
        child.inert = previous.inert
        if (previous.hidden === null) child.removeAttribute('aria-hidden')
        else child.setAttribute('aria-hidden', previous.hidden)
      }
      active--
      notify()
    }
  }, [workspace])
  useEffect(() => () => restoreFocus(opener), [])

  if (!workspace) return null
  return createPortal(<section ref={ref} className="file-expanded file-full" role="region" aria-label={label} tabIndex={-1}>{children}</section>, workspace)
}
