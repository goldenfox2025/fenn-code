import { useEffect, useRef, useState, type DragEvent, type HTMLAttributes } from 'react'

const MIME = 'application/x-fenn-library-entry'
interface Entry { library: string; path: string }
const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
const canMove = (from: string, to: string) => from !== to && !to.startsWith(from + '/') && parentOf(from) !== to

/** The shared tree handles native internal drags; source mapping and saving belong to its owner. */
export function useLibraryDrag({ id, disabled, onMove, onOpen }: { id: string; disabled: boolean; onMove: (path: string, parent: string) => Promise<void>; onOpen: (path: string) => void }) {
  const source = useRef<Entry | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const targetRef = useRef<string | null>(null)
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clear = () => { clearTimeout(hover.current); source.current = null; targetRef.current = null; setDragging(null); setTarget(null) }
  useEffect(() => { clear(); return () => clearTimeout(hover.current) }, [id])
  const accepts = (event: DragEvent, parent: string) => !disabled && event.dataTransfer.types.includes(MIME) && (!source.current || source.current.library === id && canMove(source.current.path, parent))
  const folderProps = (parent: string): HTMLAttributes<HTMLElement> => ({
    onDragOver: event => {
      event.stopPropagation()
      if (!accepts(event, parent)) { event.dataTransfer.dropEffect = 'none'; return }
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'
      if (targetRef.current !== parent) {
        clearTimeout(hover.current); targetRef.current = parent; setTarget(parent)
        if (parent) hover.current = setTimeout(() => onOpen(parent), 600)
      }
    },
    onDragLeave: event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      if (targetRef.current === parent) { clearTimeout(hover.current); targetRef.current = null; setTarget(null) }
    },
    onDrop: event => {
      event.stopPropagation()
      if (!accepts(event, parent)) return
      event.preventDefault()
      try {
        const entry: Entry = JSON.parse(event.dataTransfer.getData(MIME))
        if (entry.library === id && typeof entry.path === 'string' && canMove(entry.path, parent)) void onMove(entry.path, parent)
      } catch { /* Unrelated drags are not library entries. */ }
      clear()
    }
  })
  const rowProps = (path: string, directory: boolean): HTMLAttributes<HTMLElement> => ({
    ...(directory ? folderProps(path) : { onDragOver: (event: DragEvent) => { event.stopPropagation(); event.dataTransfer.dropEffect = 'none' } }),
    draggable: !disabled,
    onDragStart: event => {
      if (disabled || (event.target instanceof Element && event.target.closest('input,textarea,.tree-more'))) { event.preventDefault(); return }
      source.current = { library: id, path }; setDragging(path)
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(MIME, JSON.stringify(source.current))
    },
    onDragEnd: clear
  })
  return { dragging, target, folderProps, rowProps }
}
