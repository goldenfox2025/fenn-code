import { createContext, useContext, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useMenu, type MenuItem } from '../components/Menu'
import { t } from '../i18n'
import type { Widget } from './registry'

/** What a WidgetCard learns from the board it sits on: its widget, and the widget's menu. */
export const WidgetSlot = createContext<{ widget: Widget; menu: () => MenuItem[] } | null>(null)

/**
 * The frame every widget renders in, so all of them look alike: a card with an optional
 * title and, on hover, a "…" menu to move or remove the widget.
 */
export function WidgetCard({ title, className, children }: { title?: ReactNode; className?: string; children: ReactNode }) {
  const slot = useContext(WidgetSlot)
  const [menu, open] = useMenu({ align: 'right', compact: true })
  return (
    <section className={'widget ' + (slot?.widget.size ?? 'wide') + (className ? ' ' + className : '')} aria-label={slot?.widget.title}>
      {title && <div className="widget-title">{title}</div>}
      {slot && (
        <button
          className="icon-btn widget-more"
          data-tip={t('小组件选项')}
          aria-label={t('小组件选项')}
          onClick={(e) => open(e.currentTarget, slot.menu())}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
      {menu}
      {children}
    </section>
  )
}

/** A figure and what it counts, the way every widget shows one. */
export function WidgetStat({ value, label, note, before }: { value: string; label: string; note?: string; before?: ReactNode }) {
  return (
    <div className="widget-stat">
      <div className="widget-stat-value">{value}</div>
      <div className="widget-stat-label">
        {before}
        {label}
      </div>
      {note && <div className="widget-stat-note">{note}</div>}
    </div>
  )
}
