import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { usePanePresence } from '../usePanePresence'
/** A muted one-line toggle, folded by default, that opens along a thin rail (Claude's thinking line). */
export function TurnDisclosure({ label, live, children }: { label: string; live?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const { present, exiting } = usePanePresence(open)
  return (
    <div className={'steps' + (present ? ' open' : '')}>
      <button className={'steps-toggle' + (live ? ' live' : '')} aria-expanded={open} aria-controls={present ? id : undefined} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <ChevronRight size={14} className="steps-chevron" />
      </button>
      {present && <div id={id} className="steps-fold" data-exiting={exiting || undefined} inert={exiting}>
        <div className="steps-clip"><div className="steps-body">{children}</div></div>
      </div>}
    </div>
  )
}
