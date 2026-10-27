import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SegmentedControl } from './SegmentedControl'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { LibraryChange, LibraryEntry } from '@shared/model'
import { api, toast, useApp, toastError } from '../store'
import { t } from '../i18n'
import { imeComposing, relTime } from '../util'
import { humanSize } from './Outputs'
import { Markdown } from './Transcript'
import { useMenu, type MenuItem } from './Menu'
import { confirmDialog } from './Modal'
import { PanelState } from './PanelState'
import { projectFilesOwner } from '@shared/library'
import { MATERIALS, isMaterialPath, materialPath, libraryLocation, type LibraryLocation } from './files/librarySources'
import { FileExpansion, type FileViewport } from './files/FileExpansion'

/**
 * A file being edited: its text now and as last saved (both with \n line
 * ends, as a text box keeps them), the line end the file uses, and when it was
 * read or last saved (to catch an agent writing it meanwhile).
 */
interface Draft {
  path: string
  text: string
  base: string
  eol: '\n' | '\r\n'
  since?: number
}
/** Where saving stands: nothing typed yet, saved, typed and not yet saved, saving, failed, the file changed on disk meanwhile, or it was moved away. */
export type SaveState = 'clean' | 'saved' | 'pending' | 'saving' | 'error' | 'conflict' | 'gone'
/** Saving waits for the user's word: the file changed elsewhere, or went. */
export const held = (s: SaveState) => s === 'conflict' || s === 'gone'

/** Every open editor's 「save now」, for the window to call before it closes (main/index.ts flushEdits). */
const flushers = new Set<() => Promise<boolean>>()
export const flushFileEdits = async () => (await Promise.all([...flushers].map((flush) => flush()))).every(Boolean)
;(window as unknown as { __fennFlushEdits: () => Promise<unknown> }).__fennFlushEdits = () => Promise.all([...flushers].map((f) => f()))

/** Saved this long after the last keystroke, and at once on leaving the file, as editors do. */
const AUTOSAVE_MS = 700

/** Same upload encoding for the library overview and full file browser. */
export async function encodeLibraryUploads(list: FileList) {
  return Promise.all(Array.from(list).map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { name: file.name, data: btoa(binary) }
  }))
}

/**
 * Editing with autosave. Nothing asks: what is typed is written shortly
 * after, and before the editor closes, another file opens or the window
 * closes. If an agent changed the file meanwhile, or it was moved away,
 * saving stops (what was typed is kept) until the user picks what to do.
 */
export function useEditor(id: string, onSaved: () => void, locate = (path: string): LibraryLocation => ({ id, path })) {
  const [draft, setDraftState] = useState<Draft | null>(null)
  const [state, setStateRaw] = useState<SaveState>('clean')
  const cur = useRef<Draft | null>(null)
  const st = useRef<SaveState>('clean')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const running = useRef<Promise<boolean> | null>(null)
  const reading = useRef(0)
  const set = (d: Draft | null) => {
    cur.current = d
    setDraftState(d)
  }
  const setState = (v: SaveState) => {
    st.current = v
    setStateRaw(v)
  }
  const saved = useRef(onSaved)
  saved.current = onSaved

  /** Writes what is typed (one write at a time); false when it could not be saved. */
  const write = async (force = false, recreate = false): Promise<boolean> => {
    while (running.current) await running.current
    const d = cur.current
    if (!d) return true
    if (d.text === d.base && !force) {
      // Typed and undone: nothing to write.
      if (st.current === 'pending' || st.current === 'error') setState('saved')
      return !held(st.current)
    }
    const text = d.text
    const failedBefore = st.current === 'error'
    const job = (async () => {
      setState('saving')
      try {
        const target = locate(d.path)
        const r = await api().saveLibraryFile(target.id, target.path, d.eol === '\n' ? text : text.replace(/\n/g, d.eol), d.since, force, recreate)
        if (r.conflict || r.gone) {
          setState(r.gone ? 'gone' : 'conflict')
          return false
        }
        const now = cur.current
        if (now && now.path === d.path) set({ ...now, base: text, since: r.updatedAt })
        // Typing went on during the save: that part is still to save.
        setState(cur.current && cur.current.text !== text ? 'pending' : 'saved')
        saved.current()
        return true
      } catch (e) {
        setState('error')
        // Autosave retries on the next keystroke: one notice, not one per try.
        if (!failedBefore) toastError(e)
        return false
      }
    })()
    running.current = job
    try {
      return await job
    } finally {
      running.current = null
    }
  }
  const schedule = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void write(), AUTOSAVE_MS)
  }
  /** Saves now (leaving the file, closing the editor); false when it could not be saved. */
  const flush = async (): Promise<boolean> => {
    clearTimeout(timer.current)
    return held(st.current) ? false : write()
  }
  const change = (text: string) => {
    const d = cur.current
    if (!d) return
    set({ ...d, text })
    if (held(st.current)) return
    setState('pending')
    schedule()
  }
  const start = async (path: string) => {
    const request = ++reading.current
    if (!(await flush())) return
    const target = locate(path)
    const f = await api().readLibraryFile(target.id, target.path)
    if (request !== reading.current) return
    if (f?.text === undefined || f.readOnly) return
    // A text box turns \r\n into \n; the file's own line end goes back on when saving.
    const crlf = (f.text.match(/\r\n/g) ?? []).length
    const text = f.text.replace(/\r\n/g, '\n')
    set({ path, text, base: text, eol: crlf > (text.match(/\n/g) ?? []).length / 2 ? '\r\n' : '\n', since: f.updatedAt })
    setState('clean')
  }
  /** Leaves the editor once what was typed is saved; false (and stays) when it could not be. */
  const stop = async (): Promise<boolean> => {
    ++reading.current
    if (!(await flush())) return false
    set(null)
    setState('clean')
    return true
  }
  /** The file went: make it again where it was, with what was typed. */
  const recreate = () => write(true, true)
  /** Closes the file without saving what was typed (the user chose to, after it went). */
  const discard = () => {
    ++reading.current
    clearTimeout(timer.current)
    set(null)
    setState('clean')
  }
  /** After a conflict: keep the typed version (overwrite) or take the file as it is now. */
  const resolve = async (keepMine: boolean) => {
    const d = cur.current
    if (!d) return
    if (keepMine) {
      await write(true)
      return
    }
    setState('clean')
    set(null)
    await start(d.path)
  }
  /** The file was renamed, or deleted. */
  const moveTo = (fn: (path: string) => string | null) => {
    ++reading.current
    const d = cur.current
    if (!d) return
    const path = fn(d.path)
    if (path === null) {
      clearTimeout(timer.current)
      set(null)
      setState('clean')
    } else if (path !== d.path) set({ ...d, path })
  }
  // Closing the pane saves what is still unsaved.
  useEffect(
    () => () => {
      ++reading.current
      clearTimeout(timer.current)
      if (cur.current && cur.current.text !== cur.current.base && !held(st.current)) void write()
    },
    [id]
  )
  useEffect(() => {
    flushers.add(flush)
    return () => void flushers.delete(flush)
  })
  return { draft, state, change, flush, start, stop, resolve, moveTo, recreate, discard }
}

/** How a Markdown file shows: rendered (read only) or its source (typed in). */
export type MdView = 'preview' | 'source'
export const VIEW_KEY = 'oc-md-view'
export const storedView = (): MdView => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'source' ? 'source' : 'preview'
  } catch {
    return 'preview'
  }
}

/** A name being typed in place: a new name for a file or folder, or the name of a new one. */
type Naming = { mode: 'rename'; path: string; where: 'tree' | 'preview' } | { mode: 'new'; parent: string; dir: boolean }

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseName = (path: string) => path.split('/').pop() ?? path
/** `path` with its leading `from` replaced by `to` (a renamed folder moves what is in it). */
const moved = (path: string, from: string, to: string) => (path === from ? to : path.startsWith(from + '/') ? to + path.slice(from.length) : path)
const under = (path: string, of: string) => path === of || path.startsWith(of + '/')

/**
 * The files of a working folder, as in Claude Code's file panel: a tree on the
 * left (with a filter), the opened file on the right, and the files the agents
 * changed marked. Files and folders can be made, renamed, deleted (to the
 * Recycle Bin) and text files edited, here or full screen. A chat shows its
 * folder; a project shows its folder as 库. `id` is the project's or the
 * conversation's id.
 */
export function FilesPane({ id, rootLabel, initialDirectory, onBack }: { id: string; rootLabel?: string; initialDirectory?: string; onBack?: () => void }) {
  const owner = projectFilesOwner(id) ?? id
  const project = useApp((s) => s.projects.some((p) => p.id === id))
  const locate = useCallback((path: string) => libraryLocation(id, path, project), [id, project])
  const [loadError, setLoadError] = useState('')
  const currentSource = useRef(id)
  currentSource.current = id
  const [root, setRoot] = useState<string | null | undefined>(undefined)
  const [materialsRoot, setMaterialsRoot] = useState('')
  const [materialsError, setMaterialsError] = useState('')
  const [dirs, setDirs] = useState<Record<string, LibraryEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialDirectory ? [initialDirectory] : []))
  const [changes, setChanges] = useState<LibraryChange[]>([])
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [filter, setFilter] = useState('')
  const [searching, setSearching] = useState(false)
  const filterInput = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [listMode, setListMode] = useState(false)
  const rowsRef = useRef<HTMLDivElement>(null)
  const rowsScroll = useRef(0)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [view, setView] = useState<MdView>(storedView)
  const [full, setFull] = useState(false)
  const fullOpener = useRef<HTMLElement | null>(null)
  const viewport = useRef<FileViewport>(new Map())
  const [narrow, setNarrow] = useState(false)
  const [menu, openMenu] = useMenu({ align: 'right' })
  const box = useRef<HTMLDivElement>(null)
  // A reply that just finished may have changed files: list them again.
  const stamp = useApp((s) => {
    const c = s.conversations.find((x) => x.id === owner) ?? s.conversations.find((x) => x.id === s.projects.find((p) => p.id === owner)?.conversationId)
    return c ? `${c.status}:${c.updatedAt}` : ''
  })
  const threadsBusy = useApp((s) => s.conversations.filter((c) => c.projectId === owner && c.status === 'working').length)

  const load = useCallback(
    async (rel: string) => {
      try {
        const target = locate(rel)
        const res = await api().listLibrary(target.id, target.path)
        if (currentSource.current !== id) return
        if (isMaterialPath(rel)) setMaterialsError('')
        else setLoadError('')
        if (!res) return rel === '' ? setRoot(null) : undefined
        if (rel === '') setRoot(res.root)
        if (rel === MATERIALS) setMaterialsRoot(res.root)
        const entries = isMaterialPath(rel) ? res.entries.map(e => ({ ...e, path: materialPath(e.path) })) : res.entries
        setDirs((d) => ({ ...d, [rel]: entries }))
      } catch (error) {
        if (currentSource.current === id) (isMaterialPath(rel) ? setMaterialsError : setLoadError)(error instanceof Error ? error.message : String(error))
      }
    },
    [id, locate]
  )
  const reloadWith = useCallback(
    (folders: Iterable<string>) => {
      void load('')
      if (project) void load(MATERIALS)
      for (const rel of folders) if (rel !== MATERIALS) void load(rel)
      void Promise.all([api().libraryChanges(id), ...(project ? [api().libraryChanges(locate(MATERIALS).id).then(changes => changes.map(c => ({ ...c, path: materialPath(c.path) })))] : [])])
        .then((value) => { if (currentSource.current === id) setChanges(value.flat()) }, toastError)
    },
    [id, load, locate, project]
  )
  const reload = useCallback(() => reloadWith(open), [reloadWith, open])
  const editor = useEditor(id, reload, locate)
  const draft = editor.draft

  useEffect(() => {
    setDirs({})
    setOpen(new Set(initialDirectory ? [initialDirectory] : []))
    setSelected(null)
    setListMode(false)
    rowsScroll.current = 0
    returnFocus.current = null
    setNaming(null)
    setFull(false)
    setRoot(undefined)
    setMaterialsRoot('')
    setMaterialsError('')
  }, [id])
  useEffect(reload, [id, stamp, threadsBusy])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 560))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root])

  const readingFile = narrow && !!selected && !listMode && !full
  useLayoutEffect(() => {
    if (!readingFile && rowsRef.current) rowsRef.current.scrollTop = rowsScroll.current
    if (listMode && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
  }, [readingFile, listMode])

  const changed = useMemo(() => new Map(changes.filter((c) => c.exists !== false).map((c) => [c.path, c])), [changes])
  const changedDirs = useMemo(() => {
    const s = new Set<string>()
    for (const p of changed.keys()) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'))
    }
    return s
  }, [changed])

  const toggle = (rel: string) => {
    const next = new Set(open)
    if (next.has(rel)) next.delete(rel)
    else {
      next.add(rel)
      if (!dirs[rel]) void load(rel)
    }
    setOpen(next)
  }

  /** Opening another file saves the one being edited first (and stays on it if that failed). */
  const select = async (path: string) => {
    if (draft && draft.path !== path && !(await editor.stop())) {
      if (held(editor.state)) toast(t('先在文件上方选好怎么处理这个文件。'))
      return
    }
    returnFocus.current = document.activeElement as HTMLElement
    rowsScroll.current = rowsRef.current?.scrollTop ?? rowsScroll.current
    setSelected(path)
    setListMode(false)
    setView(storedView())
  }

  const backToList = async () => {
    if (await editor.stop()) setListMode(true)
  }

  const add = async (list: FileList) => {
    try {
      const files = await encodeLibraryUploads(list)
      const target = locate(uploadTarget.current)
      await api().addToLibrary(target.id, target.path, files)
      if (isMaterialPath(uploadTarget.current)) setOpen(previous => new Set([...previous, MATERIALS]))
    } catch (e) {
      toastError(e)
    }
    reload()
  }
  const picker = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef('')
  const pickFiles = (path = '') => { uploadTarget.current = path; picker.current?.click() }
  const fail = toastError
  const choose = async () => {
    const dir = await api().pickFolder()
    if (!dir) return
    try {
      if (project) await api().updateProject(id, { cwd: dir })
      else await api().updateConversation(id, { cwd: dir })
      reload()
    } catch (e) {
      fail(e)
    }
  }

  // ---- changing files ----

  const startNew = (parent: string, dir: boolean) => {
    setOnlyChanged(false)
    setFilter('')
    // A narrow pane shows the list or the file: the name is typed in the list.
    if (narrow) setListMode(true)
    if (parent && !open.has(parent)) toggle(parent)
    setNaming({ mode: 'new', parent, dir })
  }
  /** Markdown shows rendered or as source; the choice is remembered for the next file. */
  const pickView = (v: MdView) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // Not remembered this time.
    }
  }
  /** Returns false to keep the name field open (the name was refused). */
  const commitName = async (value: string): Promise<boolean> => {
    const n = naming
    if (!n) return true
    try {
      if (n.mode === 'rename') {
        if (value === baseName(n.path)) return (setNaming(null), true)
        const target = locate(n.path)
        const renamed = await api().renameLibraryPath(target.id, target.path, value)
        const to = isMaterialPath(n.path) ? materialPath(renamed) : renamed
        setNaming(null)
        const folders = new Set([...open].map((p) => moved(p, n.path, to)))
        setOpen(folders)
        if (selected) setSelected(moved(selected, n.path, to))
        editor.moveTo((p) => moved(p, n.path, to))
        reloadWith(folders)
      } else {
        const target = locate(n.parent)
        const created = await api().createLibraryEntry(target.id, target.path, value, n.dir)
        const path = isMaterialPath(n.parent) ? materialPath(created) : created
        setNaming(null)
        const folders = new Set(open)
        if (n.parent) folders.add(n.parent)
        if (n.dir) folders.add(path)
        setOpen(folders)
        reloadWith(folders)
        if (!n.dir && (await editor.stop())) {
          setSelected(path)
          setListMode(false)
          // A new file is for typing in, Markdown too.
          setView('source')
        }
      }
      return true
    } catch (e) {
      toastError(e)
      return false
    }
  }
  const remove = async (path: string, dir: boolean) => {
    const name = baseName(path)
    const ask = dir ? t('删除文件夹「{0}」和里面的所有文件？它们会移到回收站。', name) : t('删除「{0}」？它会移到回收站。', name)
    if (!(await confirmDialog(ask, { ok: t('删除') }))) return
    try {
      const target = locate(path)
      await api().deleteLibraryPath(target.id, target.path)
    } catch (e) {
      return toastError(e)
    }
    editor.moveTo((p) => (under(p, path) ? null : p))
    if (selected && under(selected, path)) {
      setSelected(null)
      setFull(false)
    }
    reload()
  }
  const fullPath = (path: string) => {
    const base = isMaterialPath(path) ? materialsRoot : root
    return base ? [base.replace(/[\\/]+$/, ''), ...locate(path).path.split('/')].join(base.includes('\\') ? '\\' : '/') : path
  }
  const openWith = (path: string, reveal: boolean) => {
    const target = locate(path)
    void api().openLibraryPath(target.id, target.path, reveal).then((r) => !r.ok && toast(r.error ?? t('打不开这个文件'), 'error'), toastError)
  }
  /** One list of actions for a file or folder, shown on right-click, on its … button and in the preview. */
  const actions = (path: string, dir: boolean, where: 'tree' | 'preview'): MenuItem[] => [
    ...(dir
      ? [
          { icon: <FilePlus size={15} />, label: t('新建文件'), onClick: () => startNew(path, false) },
          { icon: <FolderPlus size={15} />, label: t('新建文件夹'), onClick: () => startNew(path, true) },
          { separator: true }
        ]
      : []),
    { icon: <Pencil size={15} />, label: t('重命名'), hint: where === 'tree' ? 'F2' : undefined, onClick: () => setNaming({ mode: 'rename', path, where }) },
    { icon: <Copy size={15} />, label: t('复制路径'), onClick: () => void navigator.clipboard.writeText(fullPath(path)).then(() => toast(t('已复制路径'))) },
    ...(dir ? [] : [{ icon: <ExternalLink size={15} />, label: t('用默认应用打开'), onClick: () => openWith(path, false) }]),
    { icon: <FolderOpen size={15} />, label: t('在文件夹中显示'), onClick: () => openWith(path, true) },
    { separator: true },
    { icon: <Trash2 size={15} />, label: t('删除'), danger: true, onClick: () => void remove(path, dir) }
  ]
  const rowKeys = (e: React.KeyboardEvent, entry: LibraryEntry) => {
    if (e.key === 'F2') {
      e.preventDefault()
      setNaming({ mode: 'rename', path: entry.path, where: 'tree' })
    } else if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) {
      // ⌘⌫ on a Mac keyboard, where the key named Delete is Backspace.
      e.preventDefault()
      void remove(entry.path, entry.dir)
    }
  }

  const folderPrompt = (
    <PanelState title={t('还没有文件')} action={
      <div className="files-empty-actions">
        <button className="btn sm" onClick={() => void choose()}><FolderOpen size={14} />{t('选择文件夹…')}</button>
        <button className="link-btn" data-tip={t('在默认文件夹里新建')} onClick={() => void api().makeDefaultFolder(id).then(reload).catch(fail)}>{t('新建文件夹')}</button>
      </div>
    }>
      {project ? t('选择文件夹，或在默认位置新建。') : t('生成文件时，会自动创建对话文件夹。')}
    </PanelState>
  )
  if (loadError) return <div className="files-pane" ref={box}><PanelState title={t('无法读取文件')} action={<button className="btn" onClick={reload}>{t('重试')}</button>}>{loadError}</PanelState></div>
  if (root === undefined) return <div className="files-pane" ref={box}><PanelState title={t('正在读取文件…')} /></div>
  if (root === null && !project)
    return (
      <div className="files-pane" ref={box}>{folderPrompt}</div>
    )

  const q = filter.trim().toLowerCase()
  const matches = (e: LibraryEntry) => !q || e.name.toLowerCase().includes(q)
  const rows: React.ReactNode[] = []
  const newRow = (parent: string, depth: number) => {
    if (naming?.mode !== 'new' || naming.parent !== parent) return
    rows.push(
      <div key={`new:${parent}`} className="tree-row renaming" data-depth={depth} style={{ '--depth': depth } as React.CSSProperties}>
        <span className="tree-caret" />
        {naming.dir ? <Folder size={15} className="muted" /> : <File size={15} className="muted" />}
        <NameField value="" placeholder={naming.dir ? t('文件夹名') : t('文件名')} onCommit={commitName} onCancel={() => setNaming(null)} />
      </div>
    )
  }
  const walk = (rel: string, depth: number) => {
    newRow(rel, depth)
    for (const e of dirs[rel] ?? []) {
      const renaming = naming?.mode === 'rename' && naming.where === 'tree' && naming.path === e.path
      if (e.dir) {
        const isOpen = open.has(e.path) || (!!q && !!dirs[e.path])
        // While filtering, a folder shows when its name or something already listed inside it matches.
        if (q && !matches(e) && !hasMatch(e.path)) continue
        rows.push(
          <TreeRow
            key={e.path}
            entry={e}
            depth={depth}
            open={isOpen}
            mark={changedDirs.has(e.path)}
            renaming={renaming}
            onClick={() => toggle(e.path)}
            onKeyDown={(k) => rowKeys(k, e)}
            onMenu={(el) => openMenu(el, actions(e.path, true, 'tree'))}
            onCommit={commitName}
            onCancel={() => setNaming(null)}
          />
        )
        if (isOpen) walk(e.path, depth + 1)
      } else if (matches(e)) {
        rows.push(
          <TreeRow
            key={e.path}
            entry={e}
            depth={depth}
            mark={changed.has(e.path)}
            active={selected === e.path}
            renaming={renaming}
            onClick={() => void select(e.path)}
            onKeyDown={(k) => rowKeys(k, e)}
            onMenu={(el) => openMenu(el, actions(e.path, false, 'tree'))}
            onCommit={commitName}
            onCancel={() => setNaming(null)}
          />
        )
      }
    }
  }
  const hasMatch = (rel: string): boolean => (dirs[rel] ?? []).some((e) => matches(e) || (e.dir && hasMatch(e.path)))
  if (!onlyChanged) walk('', 0)
  const workspaceRows = rows.splice(0)
  const materialsVisible = project && (!!dirs[MATERIALS]?.length || !!materialsError || (naming?.mode === 'new' && isMaterialPath(naming.parent)))
  const materialsOpen = open.has(MATERIALS) || !!q
  if (!onlyChanged && materialsVisible && materialsOpen) walk(MATERIALS, 1)
  const changeRows = changes.filter((c) => !q || c.path.toLowerCase().includes(q))

  const list = (
    <div className="files-tree" hidden={readingFile}>
      {(changes.length > 0 || onlyChanged || searching) && <div className="files-tools">
        {(changes.length > 0 || onlyChanged) && <SegmentedControl className="sm files-view-tabs" label={t('库视图')} value={onlyChanged ? 'changes' : 'files'} onChange={value => setOnlyChanged(value === 'changes')} options={[{ value: 'files', label: t('文件') }, { value: 'changes', label: <>{t('更改')}{changes.length > 0 && <> <span className="files-change-count">{changes.length}</span></>}</> }]} />}
        {searching &&
        <label className="files-filter">
          <Search size={14} />
          <input ref={filterInput} autoFocus value={filter} placeholder={t('筛选文件')} onChange={(e) => setFilter(e.target.value)} onKeyDown={event => { if(event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFilter(''); setSearching(false) } }} />
          <button className="icon-btn sm" aria-label={t('关闭筛选')} onClick={() => { setFilter(''); setSearching(false) }}><X size={13} /></button>
        </label>}
      </div>}
      <div className="files-rows" ref={rowsRef} onScroll={event => { if (!readingFile) rowsScroll.current = event.currentTarget.scrollTop }}>
        {onlyChanged ? (
          changeRows.length ? (
            changeRows.map(c => {
              const entry = findEntry(dirs, c.path) ?? { name: baseName(c.path), path: c.path, dir: false, updatedAt: c.changedAt }
              const gone = c.exists === false
              return <TreeRow
                key={c.path}
                entry={entry}
                depth={0}
                change={c}
                context={parentOf(locate(c.path).path)}
                mark={!gone}
                active={selected === c.path}
                renaming={naming?.mode === 'rename' && naming.where === 'tree' && naming.path === c.path}
                onClick={() => !gone && void select(c.path)}
                onKeyDown={event => { if (!gone) rowKeys(event, entry) }}
                onMenu={el => openMenu(el, gone ? [
                  { icon: <Copy size={15} />, label: t('复制路径'), onClick: () => void navigator.clipboard.writeText(fullPath(c.path)).then(() => toast(t('已复制路径'))) }
                ] : actions(c.path, entry.dir, 'tree'))}
                onCommit={commitName}
                onCancel={() => setNaming(null)}
              />
            })
          ) : (
            <div className="files-note">{changes.length ? t('没有匹配的文件') : t('agent 还没有改过这个文件夹里的文件。')}</div>
          )
        ) : <>
        {workspaceRows.length ? workspaceRows : q ? (
          !rows.length && <div className="files-note">{t('没有匹配的文件')}</div>
        ) : root === null ? folderPrompt : (
          <PanelState title={t('文件夹是空的。')} action={
            <div className="files-empty-actions"><button className="btn sm" onClick={() => startNew('', false)}><FilePlus size={14} />{t('新建文件')}</button><button className="link-btn" onClick={() => pickFiles()}>{t('添加文件…')}</button></div>
          }>{t('新建文件，或添加已有文件。')}</PanelState>
        )}
        {materialsVisible && (!q || !!rows.length) && <div className="files-materials">
          <div className="tree-item">
            <button className="tree-row" aria-expanded={materialsOpen} onClick={() => toggle(MATERIALS)}>
              {materialsOpen ? <ChevronDown size={14} className="tree-caret" /> : <ChevronRight size={14} className="tree-caret" />}
              <Folder size={15} className="muted" /><span className="tree-name">{t('添加的资料')}</span>
            </button>
            <button className="icon-btn sm tree-more" aria-label={t('添加资料…')} data-tip={t('添加资料…')} onClick={() => pickFiles(MATERIALS)}><Plus size={14} /></button>
          </div>
          {materialsOpen && (materialsError ? <div className="files-note" role="alert">{t('无法读取资料')} <button className="link-btn" onClick={() => void load(MATERIALS)}>{t('重试')}</button></div> : rows)}
        </div>}
        </>}
      </div>
    </div>
  )

  const preview = (inFull: boolean) =>
    selected ? (
      <FilePreview
        id={locate(selected).id}
        path={locate(selected).path}
        root={(isMaterialPath(selected) ? materialsRoot : root) ?? ''}
        locationLabel={isMaterialPath(selected) ? t('添加的资料') : undefined}
        entry={findEntry(dirs, selected)}
        change={changed.get(selected)}
        onBack={narrow && !inFull ? () => void backToList() : undefined}
        draft={draft?.path === selected ? draft : null}
        saveState={editor.state}
        onDraft={editor.change}
        onEdit={() => void editor.start(selected)}
        onFlush={() => void editor.flush()}
        onResolve={(keepMine) => void editor.resolve(keepMine)}
        onRecreate={() => void editor.recreate()}
        onDiscard={() => {
          editor.discard()
          setSelected(null)
          setFull(false)
        }}
        view={view}
        onView={pickView}
        full={inFull}
        viewport={viewport}
        onFull={(value) => { if (value) fullOpener.current = document.activeElement as HTMLElement; setFull(value) }}
        renaming={naming?.mode === 'rename' && naming.where === 'preview' && naming.path === selected}
        onCommitName={commitName}
        onCancelName={() => setNaming(null)}
        onMenu={(el) => openMenu(el, actions(selected, false, 'preview'))}
      />
    ) : (
      <div className="files-preview">
        <PanelState title={t('打开的文件显示在这里')}>{t('在左边选一个文件。')}</PanelState>
      </div>
    )

  return (
    <div className={'files-pane' + (narrow ? ' narrow' : '') + (!selected ? ' unselected' : '') + (!dirs['']?.some(entry => entry.dir) ? ' flat-root' : '')} ref={box} onKeyDown={event => { if(!full && !readingFile && !(event.target instanceof HTMLTextAreaElement) && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {event.preventDefault();setSearching(true);requestAnimationFrame(() => filterInput.current?.focus())} }}>
      {!readingFile && <div className="files-head">
        {onBack && <button className="icon-btn sm" aria-label={t('返回库')} data-tip={t('返回库')} onClick={() => void editor.stop().then(ok => ok && onBack())}><ArrowLeft size={15} /></button>}
        <span className="files-root" data-tip={root ?? undefined}>
          <Folder size={14} />
          <span>{rootLabel ?? root?.split(/[\\/]/).filter(Boolean).pop() ?? t('项目文件')}</span>
        </span>
        <span className="spacer" />
        <button className={'icon-btn sm' + (searching ? ' on' : '')} data-tip={t('筛选文件')} aria-label={t('筛选文件')} aria-pressed={searching} onClick={() => { setSearching(!searching); if(searching) setFilter('') }}><Search size={15} /></button>
        <button
          className="icon-btn sm"
          data-tip={t('新建或添加文件')}
          aria-label={t('新建或添加文件')}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              ...(root ? [
                { icon: <FilePlus size={15} />, label: t('新建文件'), onClick: () => startNew('', false) },
                { icon: <FolderPlus size={15} />, label: t('新建文件夹'), onClick: () => startNew('', true) },
                { separator: true as const },
                { icon: <Upload size={15} />, label: t('添加文件…'), onClick: () => pickFiles() }
              ] : []),
              ...(project ? [{ icon: <Upload size={15} />, label: t('添加资料…'), onClick: () => pickFiles(MATERIALS) }] : [])
            ])
          }
        >
          <Plus size={15} />
        </button>
        <button className="icon-btn sm" data-tip={t('文件操作')} aria-label={t('文件操作')} onClick={event => openMenu(event.currentTarget, [
          { label: t('刷新'), icon: <RefreshCw size={15} />, onClick: reload },
          ...(root ? [{ label: t('在文件管理器中打开'), icon: <ExternalLink size={15} />, onClick: () => openWith('', false) }] : [])
        ])}>
          <MoreHorizontal size={16} />
        </button>
      </div>}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void add(e.target.files)
            e.target.value = ''
          }}
        />
      <div className="files-split">
        {list}
        {selected && (!narrow || readingFile) && (full ? <div className="files-preview" /> : preview(false))}
      </div>
      {full && selected && (
        <FileExpansion label={locate(selected).path} opener={fullOpener.current} onCollapse={() => setFull(false)}>{preview(true)}</FileExpansion>
      )}
      {menu}
    </div>
  )
}

function findEntry(dirs: Record<string, LibraryEntry[]>, path: string): LibraryEntry | undefined {
  return dirs[parentOf(path)]?.find((e) => e.path === path)
}

/**
 * A file name typed in place. The name (without its extension) starts
 * selected; Enter or leaving the field keeps it, Esc puts the old name back.
 */
export function NameField({ value, placeholder, onCommit, onCancel }: { value: string; placeholder?: string; onCommit: (name: string) => Promise<boolean>; onCancel: () => void }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    const dot = value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : value.length)
  }, [])
  const done = async (keep: boolean) => {
    if (busy.current) return
    const name = text.trim()
    if (!keep || !name) {
      busy.current = true
      return onCancel()
    }
    busy.current = true
    // Once kept, the field is done: the blur of its removal must not keep it twice.
    if (await onCommit(name)) return
    busy.current = false
    ref.current?.focus()
  }
  return (
    <input
      ref={ref}
      className="tree-input"
      value={text}
      placeholder={placeholder}
      aria-label={placeholder ?? t('重命名')}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (imeComposing(e)) return
        if (e.key === 'Enter') void done(true)
        else if (e.key === 'Escape') {
          e.preventDefault()
          void done(false)
        }
      }}
      onBlur={() => void done(true)}
    />
  )
}

function TreeRow({
  entry,
  depth,
  open,
  mark,
  change,
  context,
  active,
  renaming,
  onClick,
  onKeyDown,
  onMenu,
  onCommit,
  onCancel
}: {
  entry: LibraryEntry
  depth: number
  open?: boolean
  mark?: boolean
  change?: LibraryChange
  context?: string
  active?: boolean
  renaming?: boolean
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onMenu: (anchor: HTMLElement) => void
  onCommit: (name: string) => Promise<boolean>
  onCancel: () => void
}) {
  const style = { '--depth': depth } as React.CSSProperties
  const caret = entry.dir ? open ? <ChevronDown size={14} className="tree-caret" /> : <ChevronRight size={14} className="tree-caret" /> : <span className="tree-caret" />
  const icon = entry.dir ? <Folder size={15} className="muted" /> : <FileIcon name={entry.name} />
  const gone = change?.exists === false
  const changeLabel = gone ? t('已删除') : change?.kind === 'move' ? t('已移动') : t('agent 改过')
  if (renaming)
    return (
      <div className="tree-row renaming" style={style} data-depth={depth}>
        {caret}
        {icon}
        <NameField value={entry.name} onCommit={onCommit} onCancel={onCancel} />
      </div>
    )
  return (
    <div
      className="tree-item"
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.currentTarget.querySelector<HTMLElement>('.tree-more') ?? e.currentTarget)
      }}
    >
      <button className={'tree-row' + (change ? ' change' : '') + (gone ? ' gone' : '') + (active ? ' active' : '')} style={style} data-depth={depth} data-path={entry.path} data-tip={change ? [entry.path.startsWith(MATERIALS + '/') ? entry.path.slice(MATERIALS.length + 1) : entry.path, changeLabel, relTime(change.changedAt)].join(' · ') : entry.path} onClick={onClick} onKeyDown={onKeyDown} aria-expanded={entry.dir ? !!open : undefined} aria-disabled={gone || undefined}>
        {caret}
        {icon}
        <span className="tree-name">{entry.name}{context && <small className="tree-context">{context}</small>}</span>
        {gone && <span className="tree-status">{t('已删除')}</span>}
        {mark && <span className="tree-mark" role="img" aria-label={changeLabel} data-tip={changeLabel} />}
      </button>
      <button className="icon-btn sm tree-more" data-focus-key={'file-menu:' + entry.path} aria-label={t('更多')} data-tip={t('更多')} onClick={(e) => onMenu(e.currentTarget)}>
        <MoreHorizontal size={14} />
      </button>
    </div>
  )
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|ps1|bat|toml|ya?ml|json|xml|html?|css|scss|sql)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function FileIcon({ name }: { name: string }) {
  if (IMAGE.test(name)) return <FileImage size={15} className="muted" />
  if (CODE.test(name)) return <FileCode2 size={15} className="muted" />
  if (/\.(md|markdown|txt|log|csv)$/i.test(name)) return <FileText size={15} className="muted" />
  return <File size={15} className="muted" />
}

/**
 * The opened file, the same in the pane and full screen. A text file is
 * simply typed in (saved by itself); Markdown shows rendered (read only) or
 * as its source (typed in), switched in the header. Text in another encoding,
 * images and the rest are only shown.
 */
export function FilePreview({
  id,
  path,
  root,
  locationLabel,
  entry,
  change,
  onBack,
  draft,
  saveState,
  onDraft,
  onEdit,
  onFlush,
  onResolve,
  onRecreate,
  onDiscard,
  view,
  onView,
  full,
  onFull,
  renaming,
  onCommitName,
  onCancelName,
  onMenu,
  load,
  onClose,
  viewport
}: {
  id: string
  path: string
  root: string
  locationLabel?: string
  entry?: LibraryEntry
  change?: LibraryChange
  onBack?: () => void
  draft: Draft | null
  saveState: SaveState
  onDraft: (text: string) => void
  onEdit: () => void
  onFlush: () => void
  onResolve: (keepMine: boolean) => void
  onRecreate: () => void
  onDiscard: () => void
  view: MdView
  onView: (v: MdView) => void
  full: boolean
  onFull: (f: boolean) => void
  renaming: boolean
  onCommitName: (name: string) => Promise<boolean>
  onCancelName: () => void
  onMenu: (anchor: HTMLElement) => void
  /** Reads the file another way (one outside the working folders, read only). */
  load?: () => ReturnType<ReturnType<typeof api>['readLibraryFile']>
  /** A close button, for a file shown on its own beside a chat. */
  onClose?: () => void
  viewport?: React.RefObject<FileViewport>
}) {
  const surface = useRef<HTMLDivElement>(null)
  const [file, setFile] = useState<Awaited<ReturnType<ReturnType<typeof api>['readLibraryFile']>> | null>(null)
  useEffect(() => {
    let current = true
    setFile(null)
    void (load ? load() : api().readLibraryFile(id, path)).then((f) => { if (current) setFile(f ?? undefined) }, () => { if (current) setFile(undefined) })
    return () => { current = false }
  }, [id, path, change?.changedAt, entry?.updatedAt])
  const name = baseName(path)
  const md = /\.(md|markdown)$/i.test(name)
  const editable = !!file && file.text !== undefined && !file.readOnly
  // A text file opens ready to type in; once changed on disk by someone else (nothing typed since), it reopens as it is now.
  useEffect(() => {
    if (!editable || !file) return
    if (!draft || (draft.text === draft.base && saveState !== 'saving' && draft.since !== undefined && Math.abs(draft.since - file.updatedAt) > 1)) onEdit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, editable])
  const preview = md && view === 'preview'
  const status =
    draft && saveState !== 'clean' && !held(saveState)
      ? saveState === 'error' ? t('没能保存') : saveState === 'saved' ? t('已保存') : t('正在保存…')
      : change ? t('agent 改过') : ''
  const directory = [locationLabel ?? root.split(/[\\/]/).filter(Boolean).pop(), parentOf(path)].filter(Boolean).join(' / ')
  const readOnly = file?.readOnly === 'outside' ? t('不在工作文件夹里，只能查看') : file?.readOnly ? t('不是 UTF-8 编码，只能查看') : ''
  const metadata = [file?.size !== undefined ? humanSize(file.size) : '', entry ? relTime(entry.updatedAt) : ''].filter(Boolean).join(' · ')
  /** Ctrl+S saves at once (it saves by itself anyway). */
  const editKeys = (e: React.KeyboardEvent) => {
    if (!draft || e.defaultPrevented) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onFlush()
    }
  }
  const text = draft?.text ?? file?.text
  const positionKey = `${id}\0${path}\0${preview ? 'preview' : 'source'}`
  const rememberPosition = () => {
    const el = surface.current?.querySelector<HTMLElement>('.preview-editor, .preview-body:has(.preview-md), .preview-body:has(.preview-code)')
    if (!viewport || !el) return
    viewport.current.set(positionKey, {
      top: el.scrollTop, left: el.scrollLeft,
      ...(el instanceof HTMLTextAreaElement ? { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection } : {})
    })
  }
  useLayoutEffect(() => {
    const previous = viewport?.current.get(positionKey)
    const el = surface.current?.querySelector<HTMLElement>('.preview-editor, .preview-body:has(.preview-md), .preview-body:has(.preview-code)')
    if (!previous || !el) return
    if (el instanceof HTMLTextAreaElement && previous.start !== undefined) el.setSelectionRange(previous.start, previous.end ?? previous.start, previous.direction)
    el.scrollTop = previous.top
    el.scrollLeft = previous.left
  }, [positionKey, text !== undefined, !!draft, viewport])
  return (
    <div className="files-preview" ref={surface} onKeyDown={editKeys} onScrollCapture={rememberPosition}>
      <div className="preview-head">
        {onBack && (
          <button className="icon-btn sm" aria-label={t('返回文件列表')} data-tip={t('返回文件列表')} onClick={onBack}>
            <ArrowLeft size={15} />
          </button>
        )}
        <div className="preview-title">
          {renaming ? (
            <NameField value={name} onCommit={onCommitName} onCancel={onCancelName} />
          ) : (
            <span className="preview-name" data-tip={[`${root}/${path}`, metadata].filter(Boolean).join('\n')}>
              {name}
            </span>
          )}
          <span className="preview-subtitle">
            <span className="small muted preview-meta" data-tip={readOnly || directory}>{readOnly || directory}</span>
            {status && <span className={'preview-save-state' + (saveState === 'error' ? ' error' : '')} role="status">{status}</span>}
          </span>
        </div>
        {md && text !== undefined && (
          <SegmentedControl className="sm" label={t('显示方式')} value={preview ? 'preview' : 'source'} onChange={onView} options={[{ value: 'preview', label: t('预览') }, { value: 'source', label: t('源码') }]} />
        )}
        <button className="icon-btn sm" data-focus-key={'preview-full:' + path} data-tip={full ? t('退出全屏') : t('全屏')} aria-label={full ? t('退出全屏') : t('全屏')} onClick={() => onFull(!full)}>
          {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button className="icon-btn sm" data-focus-key={'preview-menu:' + path} data-tip={t('更多')} aria-label={t('更多')} onClick={(e) => onMenu(e.currentTarget)}>
          <MoreHorizontal size={15} />
        </button>
        {onClose && !full && (
          <button className="icon-btn sm" data-tip={t('关闭')} aria-label={t('关闭')} onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </div>
      {draft && saveState === 'conflict' && (
        <div className="preview-conflict" role="alert">
          <span>{t('这个文件在您编辑时被别处改过。')}</span>
          <span className="spacer" />
          <button className="pill-btn" onClick={() => onResolve(false)}>
            {t('用现在的文件')}
          </button>
          <button className="pill-btn" onClick={() => onResolve(true)}>
            {t('保留我的版本')}
          </button>
        </div>
      )}
      {draft && saveState === 'gone' && (
        <div className="preview-conflict" role="alert">
          <span>{t('这个文件被移走或改名了，您打的字还在。')}</span>
          <span className="spacer" />
          <button className="pill-btn" onClick={onDiscard}>
            {t('关闭')}
          </button>
          <button className="pill-btn" onClick={onRecreate}>
            {t('在原位置重新保存')}
          </button>
        </div>
      )}
      <div className="preview-body">
        {file === null && !draft ? <PanelState title={t('正在读取文件…')} /> : file === undefined && !draft ? (
          <div className="files-note">{t('文件已不在原来的位置。')}</div>
        ) : file?.image ? (
          <img className="preview-image" src={file.image} alt={name} />
        ) : text !== undefined ? (
          preview ? (
            <div className="preview-md">
              <Markdown text={text} />
            </div>
          ) : draft ? (
            <textarea
              className="preview-editor"
              value={draft.text}
              spellCheck={false}
              aria-label={t('编辑 {0}', name)}
              onChange={(e) => { rememberPosition(); onDraft(e.target.value) }}
              onSelect={rememberPosition}
              onBlur={() => { rememberPosition(); onFlush() }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                  // A tab is text here (also full screen, where Tab would move between buttons); insertText keeps the undo history.
                  e.preventDefault()
                  document.execCommand('insertText', false, '\t')
                }
              }}
            />
          ) : (
            <pre className="preview-code">{text}</pre>
          )
        ) : (
          <div className="files-note">{file?.tooBig ? t('文件太大，不在这里预览。') : t('这个文件不是文本，不在这里预览。')}</div>
        )}
      </div>
    </div>
  )
}
