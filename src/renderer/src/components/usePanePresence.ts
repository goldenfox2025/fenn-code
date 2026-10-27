import { useLayoutEffect, useState } from 'react'

/** Keep a closing pane mounted for its exit motion, without leaving it interactive. */
export function usePanePresence(open: boolean) {
  const [retained, setRetained] = useState(open)
  useLayoutEffect(() => {
    if (open) { setRetained(true); return }
    if (!retained) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const token = getComputedStyle(document.documentElement).getPropertyValue('--dur-2').trim()
    const milliseconds = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000)
    const timer = setTimeout(() => setRetained(false), reduced ? 0 : Number.isFinite(milliseconds) ? milliseconds : 160)
    return () => clearTimeout(timer)
  }, [open, retained])
  return { present: open || retained, exiting: !open }
}
