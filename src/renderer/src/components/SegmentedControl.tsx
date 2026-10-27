import { useId, type ReactNode } from 'react'

/** One native radio group, styled like the app's other compact selections. */
export function SegmentedControl<T extends string | number>({ label, value, options, onChange, disabled, className = '' }: {
  label: string
  value: T
  options: readonly { value: T; label: ReactNode }[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  const name = useId()
  return <fieldset className={`seg-control ${className}`} aria-label={label} disabled={disabled}>
    {options.map((option) => <label className={'seg-option' + (value === option.value ? ' on' : '')} key={option.value}>
      <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}
  </fieldset>
}
