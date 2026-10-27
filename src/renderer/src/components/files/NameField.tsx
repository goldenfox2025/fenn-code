import { useEffect, useId, useRef, useState } from 'react'
import { errorText, plainError } from '@shared/errors'
import { t } from '../../i18n'
import { imeComposing } from '../../util'

export type NameCommit = boolean | string

/** One naming operation: Enter/blur commit once; a refused name stays editable inline. */
export function NameField({ value, placeholder, onCommit, onCancel }: { value: string; placeholder?: string; onCommit: (name: string) => Promise<NameCommit>; onCancel: () => void }) {
  const [text, setText] = useState(value)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const errorId = useId()
  const ref = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    const dot = value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : value.length)
  }, [])
  const done = async (keep: boolean, refocus = false) => {
    if (busy.current) return
    const name = text.trim()
    if (!keep || !name) { busy.current = true; return onCancel() }
    busy.current = true; setPending(true)
    let committed = false
    try {
      const result = await onCommit(name)
      if (result === true) { committed = true; return }
      setError(typeof result === 'string' ? result : t('这个名称无法使用，请换一个。'))
    } catch (error) { setError(plainError(errorText(error))) }
    finally { if (!committed) { busy.current = false; setPending(false) } }
    if (refocus && ref.current?.isConnected) ref.current.focus()
  }
  return <span className="name-field">
    <input
      ref={ref}
      className="tree-input"
      value={text}
      placeholder={placeholder}
      aria-label={placeholder ?? t('重命名')}
      spellCheck={false}
      aria-invalid={!!error || undefined}
      aria-describedby={error ? errorId : undefined}
      readOnly={pending}
      onChange={event => { setText(event.target.value); setError('') }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation()
        if (imeComposing(event)) return
        if (event.key === 'Enter') { event.preventDefault(); void done(true, true) }
        else if (event.key === 'Escape') { event.preventDefault(); void done(false) }
      }}
      onBlur={() => void done(true)}
    />
    {error && <span className="name-field-error" id={errorId} role="alert">{error}</span>}
  </span>
}
