import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/** Contextual content, without nested dashboard cards or space-filling panels. */
export function OverviewSection({ title, count, action, children, collapsible = false, defaultOpen = true }: { title: ReactNode; count?: number; action?: ReactNode; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return <section className="overview-section"><header className="overview-section-head"><h3>{collapsible ? <button className="overview-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{title}<ChevronRight size={14} className={open ? 'open' : ''} /></button> : title}</h3>{count !== undefined && <span className="overview-count">{count}</span>}{action}</header>{(!collapsible || open) && <div className="overview-section-content">{children}</div>}</section>
}
