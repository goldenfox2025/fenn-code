import { useEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react'
import { t } from '../i18n'
import { imeComposing } from '../util'

/**
 * What an inline rename ends with: the new name, or null to leave the old one
 * (cancelled with Esc, emptied, or not changed).
 */
export function renameResult(original: string, typed: string, keep: boolean): string | null {
  const name = typed.trim()
  return keep && name && name !== original ? name : null
}

/**
 * The one field every inline rename uses (sidebar chats, projects and threads,
 * the chat and project titles, the threads board). It opens focused with the
 * old name selected; Enter or leaving the field keeps the new name, Esc puts the
 * old one back. Keys pressed while an input method is still composing belong to
 * it, not to the field. Clicks stay in the field, so the row under it doesn't open.
 */
export function RenameInput({
  value,
  onDone,
  className,
  label
}: {
  value: string
  /** Called once: the new name, or null to keep `value`. */
  onDone: (name: string | null) => void
  className?: string
  label?: string
}) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  // Enter removes the field, and its removal blurs it: the name is kept only once.
  const finished = useRef(false)
  useEffect(() => {
    const el = ref.current
    el?.focus({ preventScroll: true })
    el?.select()
  }, [])
  const finish = (keep: boolean) => {
    if (finished.current) return
    finished.current = true
    onDone(renameResult(value, text, keep))
  }
  const stay = (e: SyntheticEvent) => e.stopPropagation()
  return (
    <input
      ref={ref}
      className={'rename-input' + (className ? ' ' + className : '')}
      value={text}
      aria-label={label ?? t('重命名')}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onClick={stay}
      onDoubleClick={stay}
      onMouseDown={stay}
      onContextMenu={stay}
      onKeyDown={(e) => {
        // The row's and the app's own keys (shortcuts, Esc closing a dialog) stay out of the field.
        e.stopPropagation()
        if (imeComposing(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

/**
 * Which item of a list is being renamed (at most one), by a key of the caller's
 * choosing such as `chat:<id>`. `onTitle` goes on the text a double click renames.
 */
export function useRenaming() {
  const [editing, setEditing] = useState<string | null>(null)
  return {
    editing,
    start: setEditing as (key: string) => void,
    stop: () => setEditing(null),
    onTitle: (key: string) => ({
      onDoubleClick: (e: MouseEvent) => {
        // The double click only renames: no second open, no selected word.
        e.preventDefault()
        e.stopPropagation()
        setEditing(key)
      }
    })
  }
}
