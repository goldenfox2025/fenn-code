import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'
import type { SessionOption } from '@shared/contract'
import { effortLabel, effortRank, effortStops } from './sessionOptionLabels'
import { t } from '../i18n'

/**
 * The stop to mark 推荐: the agent's own middle setting ("medium") when it has
 * one, otherwise the middle stop. Choices are assumed to run from fastest to
 * smartest, the order agents list them in.
 */
export function recommendedEffort(o: SessionOption): number {
  const stops = effortStops(o.choices)
  const i = stops.findIndex((c) => effortRank({ value: c.value, name: '' }) === 3)
  return i >= 0 ? i : Math.floor((stops.length - 1) / 2)
}

/**
 * Like Claude's effort control: a small chip with the current level beside the
 * model name, opening a popover with a 速度更快 … 更智能 slider.
 */
export function EffortPicker({ option, value, disabled, onChange }: { option: SessionOption; value?: string; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  // Positions are in order from fastest to smartest, not the agent's listing order.
  const index = Math.max(0, effortStops(option.choices).findIndex((c) => c.value === value))
  const label = effortLabel(option, index)
  return (
    <>
      <button
        ref={chip}
        className={'effort-chip' + (open ? ' open' : '')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('努力程度')}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {label}
      </button>
      {open && chip.current && (
        <EffortPopover anchor={chip.current} option={option} index={index} disabled={disabled} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

function EffortPopover({ anchor, option, index, disabled, onChange, onClose }: {
  anchor: HTMLElement
  option: SessionOption
  index: number
  disabled?: boolean
  onChange: (value: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: -9999, top: -9999 })
  // Shown at once while the agent applies the change.
  const [at, setAt] = useState(index)
  useEffect(() => setAt(index), [index])
  const stops = effortStops(option.choices)
  const n = stops.length
  const rec = recommendedEffort(option)
  const frac = (i: number) => (n > 1 ? i / (n - 1) : 0.5)
  // Stops are evenly spaced from end to end; the thumb, the fill and 推荐 all line up on them.
  const x = (i: number) => `${frac(i) * 100}%`

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const m = ref.current!.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.right - m.width + 40, window.innerWidth - m.width - 8))
      const above = r.top - m.height - 8
      setPos({ left, top: above >= 8 ? above : r.bottom + 8 })
    }
    place()
    ref.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [anchor, onClose])

  const pick = (i: number) => {
    const next = Math.max(0, Math.min(n - 1, i))
    if (disabled || next === at) return
    setAt(next)
    onChange(stops[next].value)
  }
  const fromPointer = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * (n - 1))
  }
  const onKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }
    if (e.key in step) pick(at + step[e.key])
    else if (e.key === 'Home') pick(0)
    else if (e.key === 'End') pick(n - 1)
    else if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') {
      onClose()
      anchor.focus()
    } else return
    e.preventDefault()
    e.stopPropagation()
  }
  const name = effortLabel(option, at)

  return createPortal(
    <div className="effort-pop" role="dialog" aria-label={t('努力程度')} ref={ref} style={pos} onClick={(e) => e.stopPropagation()}>
      <div className="effort-head">
        <span className="effort-title">{t('努力程度')}</span>
        <span className="effort-level">{name}</span>
        <span className="spacer" />
        <span className="effort-help" title={t('努力程度越高，agent 思考得越多：回答更周到，但更慢，也更耗额度。')}>
          <HelpCircle size={16} />
        </span>
      </div>
      <div className="effort-ends">
        <span>{t('速度更快')}</span>
        <span>{t('更智能')}</span>
      </div>
      <div
        className={'effort-slider' + (disabled ? ' disabled' : '')}
        role="slider"
        tabIndex={0}
        aria-label={t('努力程度')}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={at}
        aria-valuetext={name}
        aria-disabled={disabled || undefined}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          if (disabled) return
          e.currentTarget.setPointerCapture(e.pointerId)
          pick(fromPointer(e.clientX))
        }}
        onPointerMove={(e) => e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId) && pick(fromPointer(e.clientX))}
      >
        <div className="effort-track" ref={track}>
          <div className="effort-fill" style={{ width: x(at) }} />
          {stops.map((c, i) => (
            <span key={c.value} className={'effort-stop' + (i < at ? ' under' : '')} style={{ left: x(i) }} title={effortLabel(option, i)} />
          ))}
          <span className="effort-thumb" style={{ left: x(at) }} />
        </div>
      </div>
      <div className="effort-marks">
        <span className="effort-rec" style={{ left: x(rec) }}>
          {t('推荐')}
        </span>
      </div>
    </div>,
    document.body
  )
}
