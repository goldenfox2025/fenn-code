import type { ReactNode } from 'react'

/** Compact loading/empty/error states for side panels; never inherit a full-page empty layout. */
export function PanelState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="panel-empty-state"><strong>{title}</strong>{children && <div>{children}</div>}{action && <div className="panel-empty-action">{action}</div>}</div>
}
