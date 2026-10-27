import { useLayoutEffect, useRef, useState } from 'react'

/** Keep the full controls measurable while collapsed, so widening restores them without oscillation. */
export function useComposerFit() {
  const row = useRef<HTMLDivElement>(null)
  const controls = useRef<HTMLSpanElement>(null)
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const parent = row.current!, full = controls.current!
    const fit = () => {
      const children = [...parent.children] as HTMLElement[]
      const gap = parseFloat(getComputedStyle(parent).columnGap) || 0
      const other = children.filter((el) => !el.classList.contains('spacer') && !el.classList.contains('model-group'))
      const group = parent.querySelector<HTMLElement>('.model-group')!
      const context = group.querySelector<HTMLElement>('.context-ring')
      const needed = full.getBoundingClientRect().width + (context ? context.getBoundingClientRect().width + 1 : 0)
        + other.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) + gap * (other.length + 1)
      setCompact(needed > parent.clientWidth + 0.5)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(parent); ro.observe(full)
    const observeChildren = () => { for (const child of parent.children) if (!child.classList.contains('spacer')) ro.observe(child) }
    observeChildren()
    const mutations = new MutationObserver(() => { observeChildren(); fit() })
    mutations.observe(parent, { childList: true })
    fit()
    return () => { ro.disconnect(); mutations.disconnect() }
  }, [])
  return { row, controls, compact }
}
