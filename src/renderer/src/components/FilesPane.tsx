import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  FolderSearch,
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
import { relTime } from '../util'
import { humanSize } from './Outputs'
import { Markdown } from './Transcript'
import { useMenu, type MenuItem } from './Menu'
import { confirmDialog, Overlay } from './Modal'

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
;(window as unknown as { __fennFlushEdits: () => Promise<unknown> }).__fennFlushEdits = () => Promise.all([...flushers].map((f) => f()))

/** Saved this long after the last keystroke, and at once on leaving the file, as editors do. */
const AUTOSAVE_MS = 700

/**
 * Editing with autosave. Nothing asks: what is typed is written shortly
 * after, and before the editor closes, another file opens or the window
 * closes. If an agent changed the file meanwhile, or it was moved away,
 * saving stops (what was typed is kept) until the user picks what to do.
 */
export function useEditor(id: string, onSaved: () => void) {
  const [draft, setDraftState] = useState<Draft | null>(null)
  const [state, setStateRaw] = useState<SaveState>('clean')
  const cur = useRef<Draft | null>(null)
  const st = useRef<SaveState>('clean')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const running = useRef<Promise<boolean> | null>(null)
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
        const r = await api().saveLibraryFile(id, d.path, d.eol === '\n' ? text : text.replace(/\n/g, d.eol), d.since, force, recreate)
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
    if (!(await flush())) return
    const f = await api().readLibraryFile(id, path)
    if (f?.text === undefined || f.readOnly) return
    // A text box turns \r\n into \n; the file's own line end goes back on when saving.
    const crlf = (f.text.match(/\r\n/g) ?? []).length
    const text = f.text.replace(/\r\n/g, '\n')
    set({ path, text, base: text, eol: crlf > (text.match(/\n/g) ?? []).length / 2 ? '\r\n' : '\n', since: f.updatedAt })
    setState('clean')
  }
  /** Leaves the editor once what was typed is saved; false (and stays) when it could not be. */
  const stop = async (): Promise<boolean> => {
    if (!(await flush())) return false
    set(null)
    setState('clean')
    return true
  }
  /** The file went: make it again where it was, with what was typed. */
  const recreate = () => write(true, true)
  /** Closes the file without saving what was typed (the user chose to, after it went). */
  const discard = () => {
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
export function FilesPane({ id }: { id: string }) {
  const [root, setRoot] = useState<string | null | undefined>(undefined)
  const [dirs, setDirs] = useState<Record<string, LibraryEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [changes, setChanges] = useState<LibraryChange[]>([])
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [view, setView] = useState<MdView>(storedView)
  const [full, setFull] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [menu, openMenu] = useMenu({ align: 'right' })
  const box = useRef<HTMLDivElement>(null)
  // A reply that just finished may have changed files: list them again.
  const stamp = useApp((s) => {
    const c = s.conversations.find((x) => x.id === id) ?? s.conversations.find((x) => x.id === s.projects.find((p) => p.id === id)?.conversationId)
    return c ? `${c.status}:${c.updatedAt}` : ''
  })
  const threadsBusy = useApp((s) => s.conversations.filter((c) => c.projectId === id && c.status === 'working').length)

  const load = useCallback(
    async (rel: string) => {
      const res = await api().listLibrary(id, rel)
      if (!res) return rel === '' ? setRoot(null) : undefined
      if (rel === '') setRoot(res.root)
      setDirs((d) => ({ ...d, [rel]: res.entries }))
    },
    [id]
  )
  const reloadWith = useCallback(
    (folders: Iterable<string>) => {
      void load('')
      for (const rel of folders) void load(rel)
      void api().libraryChanges(id).then(setChanges)
    },
    [id, load]
  )
  const reload = useCallback(() => reloadWith(open), [reloadWith, open])
  const editor = useEditor(id, reload)
  const draft = editor.draft

  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    setSelected(null)
    setNaming(null)
    setFull(false)
    setRoot(undefined)
  }, [id])
  useEffect(reload, [id, stamp, threadsBusy])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 560))
    ro.observe(el)
    return () => ro.disconnect()
  }, [root])

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
    setSelected(path)
    setView(storedView())
  }

  const add = async (list: FileList) => {
    try {
      const files = await Promise.all(
        Array.from(list).map(async (f) => {
          const buf = new Uint8Array(await f.arrayBuffer())
          let bin = ''
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
          return { name: f.name, data: btoa(bin) }
        })
      )
      await api().addToLibrary(id, '', files)
    } catch (e) {
      toastError(e)
    }
    reload()
  }
  const picker = useRef<HTMLInputElement>(null)
  const project = useApp((s) => s.projects.some((p) => p.id === id))
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
    if (narrow) setSelected(null)
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
        const to = await api().renameLibraryPath(id, n.path, value)
        setNaming(null)
        const folders = new Set([...open].map((p) => moved(p, n.path, to)))
        setOpen(folders)
        if (selected) setSelected(moved(selected, n.path, to))
        editor.moveTo((p) => moved(p, n.path, to))
        reloadWith(folders)
      } else {
        const path = await api().createLibraryEntry(id, n.parent, value, n.dir)
        setNaming(null)
        const folders = new Set(open)
        if (n.parent) folders.add(n.parent)
        if (n.dir) folders.add(path)
        setOpen(folders)
        reloadWith(folders)
        if (!n.dir && (await editor.stop())) {
          setSelected(path)
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
      await api().deleteLibraryPath(id, path)
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
  const fullPath = (path: string) => (root ? [root.replace(/[\\/]+$/, ''), ...path.split('/')].join(root.includes('\\') ? '\\' : '/') : path)
  const openWith = (path: string, reveal: boolean) => void api().openLibraryPath(id, path, reveal).then((r) => !r.ok && r.error && toast(r.error, 'error'))
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
    } else if (e.key === 'Delete') {
      e.preventDefault()
      void remove(entry.path, entry.dir)
    }
  }

  if (root === undefined) return <div className="files-pane" ref={box} />
  if (root === null)
    return (
      <div className="files-pane" ref={box}>
        <div className="empty">
          <FolderSearch size={22} />
          <div>{t('还没有文件夹')}</div>
          <div className="small">{project ? t('给这个项目一个文件夹，这里就会列出它的文件。') : t('不选也行：agent 一做出文件，就会自动放进默认文件夹里以对话命名的文件夹。')}</div>
          <div className="empty-actions">
            <button className="btn sm" onClick={() => void api().makeDefaultFolder(id).then(reload).catch(fail)}>
              <FolderPlus size={14} />
              {t('在默认文件夹里新建')}
            </button>
            <button className="btn sm" onClick={() => void choose()}>
              <FolderOpen size={14} />
              {t('选择文件夹…')}
            </button>
          </div>
        </div>
      </div>
    )

  const q = filter.trim().toLowerCase()
  const matches = (e: LibraryEntry) => !q || e.name.toLowerCase().includes(q)
  const rows: React.ReactNode[] = []
  const newRow = (parent: string, depth: number) => {
    if (naming?.mode !== 'new' || naming.parent !== parent) return
    rows.push(
      <div key={`new:${parent}`} className="tree-row renaming" style={{ '--depth': depth } as React.CSSProperties}>
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
  const changeRows = changes.filter((c) => !q || c.path.toLowerCase().includes(q))

  const list = (
    <div className="files-tree">
      <div className="files-tools">
        <label className="files-filter">
          <Search size={14} />
          <input value={filter} placeholder={t('筛选文件')} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <button className={'chip' + (onlyChanged ? ' on' : '')} aria-pressed={onlyChanged} data-tip={t('只看 agent 改过的文件')} onClick={() => setOnlyChanged(!onlyChanged)}>
          {t('改动')} {changes.length > 0 && <span className="muted">{changes.length}</span>}
        </button>
      </div>
      <div className="files-rows">
        {onlyChanged ? (
          changeRows.length ? (
            changeRows.map((c) => (
              <button key={c.path} className={'tree-row change' + (selected === c.path ? ' active' : '') + (c.exists === false ? ' gone' : '')} onClick={() => c.exists !== false && void select(c.path)}>
                <FileIcon name={c.path} />
                <span className="tree-name">{c.path}</span>
                <span className="tree-meta">{c.exists === false ? t('已删除') : c.kind === 'move' ? t('已移动') : t('已修改')} · {relTime(c.changedAt)}</span>
              </button>
            ))
          ) : (
            <div className="files-note">{changes.length ? t('没有匹配的文件') : t('agent 还没有改过这个文件夹里的文件。')}</div>
          )
        ) : rows.length ? (
          rows
        ) : q ? (
          <div className="files-note">{t('没有匹配的文件')}</div>
        ) : (
          <div className="empty">
            <FolderOpen size={22} />
            <div>{t('文件夹是空的。')}</div>
            <div className="small">{t('agent 写的文件和您添加的文件会出现在这里。')}</div>
          </div>
        )}
      </div>
    </div>
  )

  const preview = (inFull: boolean) =>
    selected ? (
      <FilePreview
        id={id}
        path={selected}
        root={root}
        entry={findEntry(dirs, selected)}
        change={changed.get(selected)}
        onBack={narrow && !inFull ? () => void editor.stop().then((ok) => ok && setSelected(null)) : undefined}
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
        onFull={setFull}
        renaming={naming?.mode === 'rename' && naming.where === 'preview' && naming.path === selected}
        onCommitName={commitName}
        onCancelName={() => setNaming(null)}
        onMenu={(el) => openMenu(el, actions(selected, false, 'preview'))}
      />
    ) : (
      <div className="files-preview">
        <div className="empty">
          <FolderOpen size={22} />
          <div>{t('打开的文件显示在这里')}</div>
          <div className="small">{t('在左边选一个文件。')}</div>
        </div>
      </div>
    )

  return (
    <div className={'files-pane' + (narrow ? ' narrow' : '')} ref={box}>
      <div className="files-head">
        <span className="files-root" data-tip={root}>
          <Folder size={14} />
          <span>{root.split(/[\\/]/).filter(Boolean).pop()}</span>
        </span>
        <span className="spacer" />
        <button
          className="icon-btn sm"
          data-tip={t('新建或添加文件')}
          aria-label={t('新建或添加文件')}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { icon: <FilePlus size={15} />, label: t('新建文件'), onClick: () => startNew('', false) },
              { icon: <FolderPlus size={15} />, label: t('新建文件夹'), onClick: () => startNew('', true) },
              { separator: true },
              { icon: <Upload size={15} />, label: t('添加文件…'), onClick: () => picker.current?.click() }
            ])
          }
        >
          <Plus size={15} />
        </button>
        <button className="icon-btn sm" data-tip={t('刷新')} aria-label={t('刷新')} onClick={reload}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" data-tip={t('在文件管理器中打开')} aria-label={t('在文件管理器中打开')} onClick={() => openWith('', false)}>
          <ExternalLink size={14} />
        </button>
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
      </div>
      <div className="files-split">
        {(!narrow || !selected || full) && list}
        {(!narrow || (selected && !full)) && (full ? <div className="files-preview" /> : preview(false))}
      </div>
      {full && selected && (
        <Overlay onClose={() => setFull(false)}>
          <div className="modal file-full">{preview(true)}</div>
        </Overlay>
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
function NameField({ value, placeholder, onCommit, onCancel }: { value: string; placeholder?: string; onCommit: (name: string) => Promise<boolean>; onCancel: () => void }) {
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
  if (renaming)
    return (
      <div className="tree-row renaming" style={style}>
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
      <button className={'tree-row' + (active ? ' active' : '')} style={style} data-path={entry.path} onClick={onClick} onKeyDown={onKeyDown} aria-expanded={entry.dir ? !!open : undefined}>
        {caret}
        {icon}
        <span className="tree-name">{entry.name}</span>
        {mark && <span className="tree-mark" data-tip={t('agent 改过')} />}
      </button>
      <button className="icon-btn sm tree-more" data-focus-key={'file-menu:' + entry.path} aria-label={t('更多')} data-tip={t('更多')} onClick={(e) => onMenu(e.currentTarget)}>
        <MoreHorizontal size={14} />
      </button>
    </div>
  )
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|swift|sh|ps1|bat|toml|ya?ml|json|xml|html?|css|scss|sql)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

function FileIcon({ name }: { name: string }) {
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
  onClose
}: {
  id: string
  path: string
  root: string
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
}) {
  const [file, setFile] = useState<Awaited<ReturnType<ReturnType<typeof api>['readLibraryFile']>> | null>(null)
  useEffect(() => {
    setFile(null)
    void (load ? load() : api().readLibraryFile(id, path)).then((f) => setFile(f ?? undefined), () => setFile(undefined))
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
  const meta =
    draft && saveState !== 'clean' && !held(saveState)
      ? [saveState === 'error' ? t('没能保存') : saveState === 'saved' ? t('已保存') : t('正在保存…')]
      : [file?.size !== undefined ? humanSize(file.size) : '', entry ? relTime(entry.updatedAt) : '', change ? t('agent 改过') : '', file?.readOnly === 'outside' ? t('不在工作文件夹里，只能查看') : file?.readOnly ? t('不是 UTF-8 编码，只能查看') : '']
  /** Ctrl+S saves at once (it saves by itself anyway). */
  const editKeys = (e: React.KeyboardEvent) => {
    if (!draft || e.defaultPrevented) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onFlush()
    }
  }
  const text = draft?.text ?? file?.text
  return (
    <div className="files-preview" onKeyDown={editKeys}>
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
            <span className="preview-name" data-tip={`${root}/${path}`}>
              {name}
            </span>
          )}
          <span className="small muted">{meta.filter(Boolean).join(' · ')}</span>
        </div>
        <span className="spacer" />
        {md && text !== undefined && (
          <div className="seg-control sm" role="group" aria-label={t('显示方式')}>
            <button className={preview ? 'on' : ''} aria-pressed={preview} onClick={() => onView('preview')}>
              {t('预览')}
            </button>
            <button className={preview ? '' : 'on'} aria-pressed={!preview} onClick={() => onView('source')}>
              {t('源码')}
            </button>
          </div>
        )}
        <button className="icon-btn sm" data-tip={full ? t('退出全屏') : t('全屏')} aria-label={full ? t('退出全屏') : t('全屏')} onClick={() => onFull(!full)}>
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
        {file === null && !draft ? null : file === undefined && !draft ? (
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
              onChange={(e) => onDraft(e.target.value)}
              onBlur={onFlush}
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
