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
  Upload
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
 * read (to catch an agent writing it meanwhile).
 */
interface Draft {
  path: string
  text: string
  base: string
  eol: '\n' | '\r\n'
  since?: number
}
/** A name being typed in place: a new name for a file or folder, or the name of a new one. */
type Naming = { mode: 'rename'; path: string; where: 'tree' | 'preview' } | { mode: 'new'; parent: string; dir: boolean }

/** Unsaved edits per files panel, kept when the panel closes or switches tab. */
const drafts = new Map<string, Draft>()

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
  const [selected, setSelected] = useState<string | null>(() => drafts.get(id)?.path ?? null)
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(id) ?? null)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [rendered, setRendered] = useState(true)
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

  /** Takes the new draft, or a change to the latest one (a save that ends while typing goes on keeps the typing). */
  const setDraft = useCallback(
    (d: Draft | null | ((prev: Draft | null) => Draft | null)) =>
      setDraftState((prev) => {
        const next = typeof d === 'function' ? d(prev) : d
        if (next) drafts.set(id, next)
        else drafts.delete(id)
        return next
      }),
    [id]
  )
  const saving = useRef(false)
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

  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    setSelected(drafts.get(id)?.path ?? null)
    setDraftState(drafts.get(id) ?? null)
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

  /** Unsaved edits are only dropped once the user says so. */
  const dropDraft = async (): Promise<boolean> => {
    if (!draft) return true
    if (draft.text !== draft.base && !(await confirmDialog(t('放弃对「{0}」没保存的修改？', baseName(draft.path)), { ok: t('放弃') }))) return false
    setDraft(null)
    setRendered(true)
    return true
  }
  const select = async (path: string) => {
    if (draft && draft.path !== path && !(await dropDraft())) return
    setSelected(path)
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
  const edit = async (path: string) => {
    const f = await api().readLibraryFile(id, path)
    if (f?.text === undefined || f.readOnly) return
    // A text box turns \r\n into \n; the file's own line end goes back on when saving.
    const crlf = (f.text.match(/\r\n/g) ?? []).length
    const text = f.text.replace(/\r\n/g, '\n')
    setDraft({ path, text, base: text, eol: crlf > (text.match(/\n/g) ?? []).length / 2 ? '\r\n' : '\n', since: f.updatedAt })
    setRendered(false)
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
        setDraft((d) => d && { ...d, path: moved(d.path, n.path, to) })
        reloadWith(folders)
      } else {
        const path = await api().createLibraryEntry(id, n.parent, value, n.dir)
        setNaming(null)
        const folders = new Set(open)
        if (n.parent) folders.add(n.parent)
        if (n.dir) folders.add(path)
        setOpen(folders)
        reloadWith(folders)
        if (!n.dir && (await dropDraft())) {
          setSelected(path)
          await edit(path)
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
    setDraft((d) => (d && under(d.path, path) ? null : d))
    if (selected && under(selected, path)) {
      setSelected(null)
      setFull(false)
    }
    reload()
  }
  const save = async (close: boolean, force = false): Promise<void> => {
    if (!draft || saving.current) return
    const { path, text, eol, since } = draft
    // Nothing changed: nothing is written.
    if (text === draft.base && !force) {
      if (close) {
        setDraft(null)
        setRendered(true)
      }
      return
    }
    saving.current = true
    try {
      const r = await api().saveLibraryFile(id, path, eol === '\n' ? text : text.replace(/\n/g, eol), since, force)
      if (r.conflict) {
        saving.current = false
        if (await confirmDialog(t('「{0}」在您编辑时被改过（可能是 agent 改的）。用您的版本覆盖它？', baseName(path)), { ok: t('覆盖') })) return save(close, true)
        return toast(t('没有保存。想看文件现在的内容，点「取消」退出编辑。'))
      }
      // What was typed while saving stays, and stays unsaved.
      const closing = close && draft.text === text
      setDraft((d) => (!d || d.path !== path ? d : closing && d.text === text ? null : { ...d, base: text, since: r.updatedAt }))
      if (closing) setRendered(true)
      reload()
    } catch (e) {
      toastError(e)
    } finally {
      saving.current = false
    }
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
        onBack={narrow && !inFull ? () => setSelected(null) : undefined}
        draft={draft?.path === selected ? draft : null}
        onDraft={(text) => setDraft((d) => d && { ...d, text })}
        onEdit={() => void edit(selected)}
        onSave={(close) => void save(close)}
        onCancelEdit={() => void dropDraft()}
        rendered={rendered}
        onRendered={setRendered}
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

/** The opened file: shown (Markdown rendered), or edited in place; the same view in the pane and full screen. */
function FilePreview({
  id,
  path,
  root,
  entry,
  change,
  onBack,
  draft,
  onDraft,
  onEdit,
  onSave,
  onCancelEdit,
  rendered,
  onRendered,
  full,
  onFull,
  renaming,
  onCommitName,
  onCancelName,
  onMenu
}: {
  id: string
  path: string
  root: string
  entry?: LibraryEntry
  change?: LibraryChange
  onBack?: () => void
  draft: Draft | null
  onDraft: (text: string) => void
  onEdit: () => void
  onSave: (close: boolean) => void
  onCancelEdit: () => void
  rendered: boolean
  onRendered: (r: boolean) => void
  full: boolean
  onFull: (f: boolean) => void
  renaming: boolean
  onCommitName: (name: string) => Promise<boolean>
  onCancelName: () => void
  onMenu: (anchor: HTMLElement) => void
}) {
  const [file, setFile] = useState<Awaited<ReturnType<ReturnType<typeof api>['readLibraryFile']>> | null>(null)
  useEffect(() => {
    setFile(null)
    void api().readLibraryFile(id, path).then((f) => setFile(f ?? undefined))
  }, [id, path, change?.changedAt, entry?.updatedAt])
  const name = baseName(path)
  const md = /\.(md|markdown)$/i.test(name)
  const editing = !!draft
  const dirty = !!draft && draft.text !== draft.base
  const meta = editing
    ? [dirty ? t('未保存') : t('正在编辑')]
    : [file?.size !== undefined ? humanSize(file.size) : '', entry ? relTime(entry.updatedAt) : '', change ? t('agent 改过') : '', file?.readOnly ? t('不是 UTF-8 编码，只能查看') : '']
  // The rendered draft takes the keys (Ctrl+S, Esc) while it shows.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (editing && md && rendered) body.current?.focus({ preventScroll: true })
  }, [editing, md, rendered])
  /** Ctrl+S saves and Esc leaves, wherever focus is in the file being edited. */
  const editKeys = (e: React.KeyboardEvent) => {
    if (!editing || e.defaultPrevented) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      onSave(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancelEdit()
    }
  }
  const fullBtn = (
    <button className="icon-btn sm" data-tip={full ? t('退出全屏') : t('全屏')} aria-label={full ? t('退出全屏') : t('全屏')} onClick={() => onFull(!full)}>
      {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  )
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
        {md && (editing || file?.text !== undefined) && (
          <button className="pill-btn" onClick={() => onRendered(!rendered)}>
            {rendered ? t('源码') : t('预览')}
          </button>
        )}
        {editing ? (
          <>
            <button className="btn sm" onClick={onCancelEdit}>
              {t('取消')}
            </button>
            <button className="btn sm primary" data-tip={t('保存 (Ctrl+S)')} disabled={!dirty} onClick={() => onSave(true)}>
              {t('保存')}
            </button>
            {fullBtn}
          </>
        ) : (
          <>
            {file?.text !== undefined && !file.readOnly && (
              <button className="icon-btn sm" data-tip={t('编辑')} aria-label={t('编辑')} onClick={onEdit}>
                <Pencil size={14} />
              </button>
            )}
            {fullBtn}
            <button className="icon-btn sm" data-focus-key={'preview-menu:' + path} data-tip={t('更多')} aria-label={t('更多')} onClick={(e) => onMenu(e.currentTarget)}>
              <MoreHorizontal size={15} />
            </button>
          </>
        )}
      </div>
      <div className="preview-body" ref={body} tabIndex={editing && md && rendered ? -1 : undefined}>
        {draft ? (
          md && rendered ? (
            <div className="preview-md">
              <Markdown text={draft.text} />
            </div>
          ) : (
            <textarea
              className="preview-editor"
              value={draft.text}
              spellCheck={false}
              autoFocus
              aria-label={t('编辑 {0}', name)}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                  // A tab is text here (also full screen, where Tab would move between buttons); insertText keeps the undo history.
                  e.preventDefault()
                  document.execCommand('insertText', false, '\t')
                }
              }}
            />
          )
        ) : file === null ? null : file === undefined ? (
          <div className="files-note">{t('文件已不在原来的位置。')}</div>
        ) : file.image ? (
          <img className="preview-image" src={file.image} alt={name} />
        ) : file.text !== undefined ? (
          md && rendered ? (
            <div className="preview-md">
              <Markdown text={file.text} />
            </div>
          ) : (
            <pre className="preview-code">{file.text}</pre>
          )
        ) : (
          <div className="files-note">{file.tooBig ? t('文件太大，不在这里预览。') : t('这个文件不是文本，不在这里预览。')}</div>
        )}
      </div>
    </div>
  )
}
