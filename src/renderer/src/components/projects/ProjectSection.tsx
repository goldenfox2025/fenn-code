import type { ReactNode } from 'react'

/** Shared layout for project information pages; headers and empty states have distinct roles. */
export function ProjectSection({ title, description, icon, action, children }: {
  title: string; description?: string; icon: ReactNode; action?: ReactNode; children: ReactNode
}) {
  return <section className="project-section">
    <header className="project-section-head"><div className="project-section-title">{icon}<h2>{title}</h2></div>{action}</header>
    {description && <p className="project-section-description">{description}</p>}
    <div className="project-section-content">{children}</div>
  </section>
}

export function ProjectEmpty({ title, description, icon, action, compact = false }: {
  title: string; description: string; icon: ReactNode; action: ReactNode; compact?: boolean
}) {
  if (compact) return <div className="project-section-note"><p>{description}</p><div>{action}</div></div>
  return <div className="project-empty">
    <span className="project-empty-icon" aria-hidden="true">{icon}</span>
    <h3>{title}</h3><p>{description}</p><div>{action}</div>
  </div>
}
