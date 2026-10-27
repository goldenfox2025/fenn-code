import { useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useMenu } from './Menu'
import { t } from '../i18n'

interface Tab<T extends string> { id: T; label: string; icon?: ReactNode }

/** Keyboard behavior shared by the restored main-branch tab bars. */
export function panelTabKeys(event: KeyboardEvent<HTMLDivElement>) {
  if ((event.target as HTMLElement).getAttribute('role') !== 'tab' || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role=tab]:not(:disabled)')]
  const index = tabs.indexOf(event.target as HTMLButtonElement)
  if (index < 0 || !tabs.length) return
  event.preventDefault()
  const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]
  next.focus({preventScroll:true}); next.click()
}

/** Measure intrinsic labels, not viewport breakpoints. The active destination stays visible. */
export function OverflowTabs<T extends string>({ items, value, onChange, iconOnly = false, onActiveClick }: { items: Tab<T>[]; value: T; onChange: (id: T) => void; iconOnly?: boolean; onActiveClick?: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const sizes = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState<T[]>(items.map((item) => item.id))
  const [menu, open, update, close] = useMenu({ align: 'left', compact: true })
  const signature = items.map((item) => `${item.id}:${item.label}`).join('|')
  useLayoutEffect(() => {
    const container = root.current!, measure = sizes.current!
    const fit = () => {
      const widths = new Map([...measure.querySelectorAll<HTMLElement>('[data-size]')].map((el) => [el.dataset.size!, el.getBoundingClientRect().width]))
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0
      const width = container.clientWidth
      const total = items.reduce((sum, item) => sum + (widths.get(item.id) ?? 0), 0) + gap * (items.length - 1)
      let next = items.map((item) => item.id)
      if (total > width + 0.5) {
        let room = width - (widths.get('overflow') ?? 28) - gap
        const picked = new Set<T>()
        // Pin the selected view; fill the remaining space in the established navigation order.
        for (const item of [...items.filter((item) => item.id === value), ...items.filter((item) => item.id !== value)]) {
          const need = (widths.get(item.id) ?? 0) + (picked.size ? gap : 0)
          if (need <= room + 0.5) { picked.add(item.id); room -= need }
        }
        next = items.filter((item) => picked.has(item.id)).map((item) => item.id)
      }
      setVisible((old) => old.join('|') === next.join('|') ? old : next)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(container); ro.observe(measure)
    return () => ro.disconnect()
  }, [signature, value, iconOnly])
  const hidden = items.filter((item) => !visible.includes(item.id))
  const menuItems = () => hidden.map((item) => ({ label: item.label, icon: item.icon, checked: value === item.id, onClick: () => onChange(item.id) }))
  useLayoutEffect(() => { close() }, [visible.join('|')])
  useLayoutEffect(() => { update(menuItems()) }, [value, signature])
  return <div className={'tabs overflow-tabs' + (iconOnly ? ' icon-only' : '')} ref={root} role="tablist" aria-label={t('项目导航')}>
    <div className="overflow-tabs-measure" ref={sizes} aria-hidden inert>
      {items.map((item) => <span className="tab-size" data-size={item.id} key={item.id}>{iconOnly ? item.icon : item.label}</span>)}
      <span className="icon-btn" data-size="overflow"><MoreHorizontal size={16} /></span>
    </div>
    {items.filter((item) => visible.includes(item.id)).map((item) => <button key={item.id} role="tab" data-tab={item.id} aria-label={item.label} data-tip={iconOnly ? item.label : undefined} aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1} className={'tab' + (value === item.id ? ' active' : '')} onClick={() => value === item.id && onActiveClick ? onActiveClick() : onChange(item.id)} onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const shown = items.filter((entry) => visible.includes(entry.id))
      const at = shown.findIndex((entry) => entry.id === item.id)
      const next = shown[e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : shown.length - 1)) % shown.length]
      if (next) { onChange(next.id); root.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus() }
    }}>{iconOnly ? item.icon : item.label}</button>)}
    {!!hidden.length && <button className="icon-btn" data-more aria-haspopup="menu" aria-label={t('更多')} data-tip={t('更多')} onClick={(e) => open(e.currentTarget, menuItems())}><MoreHorizontal size={16} /></button>}
    {menu}
  </div>
}
