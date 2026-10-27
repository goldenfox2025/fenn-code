import { useLayoutEffect, type RefObject } from 'react'

/** Freeze the pane's content measure while its outer layout space contracts. */
export function usePaneViewport(ref: RefObject<HTMLElement | null>, present: boolean) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !present) return
    const measure = () => {
      if (!el.hasAttribute('data-exiting') && el.clientWidth > 0)
        el.style.setProperty('--pane-content-width', `${el.clientWidth}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, present])
}
