import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, File, FileCode2, FileImage, FileText, Folder, FolderOpen, FolderPlus, FolderSearch, Plus, RefreshCw, Search } from 'lucide-react'
import type { LibraryChange, LibraryEntry } from '@shared/model'
import { api, toast, useApp, toastError } from '../store'
import { t } from '../i18n'
import { relTime } from '../util'
import { humanSize } from './Outputs'
import { Markdown } from './Transcript'

/**
 * The files of a working folder, as in Claude Code's file panel: a tree on the
 * left (with a filter), the opened file on the right, and the files the agents
 * changed marked. A chat shows its folder; a project shows its folder as 库.
 * `id` is the project's or the conversation's id.
 */
export function FilesPane({ id }: { id: string }) {
  const [root, setRoot] = useState<string | null | undefined>(undefined)
  const [dirs, setDirs] = useState<Record<string, LibraryEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [changes, setChanges] = useState<LibraryChange[]>([])
  const [onlyChanged, setOnlyChanged] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [narrow, setNarrow] = useState(false)
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
  const reload = useCallback(() => {
    void load('')
    for (const rel of open) void load(rel)
    void api().libraryChanges(id).then(setChanges)
  }, [id, load, open])

  useEffect(() => {
    setDirs({})
    setOpen(new Set())
    setSelected(null)
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
  const walk = (rel: string, depth: number) => {
    for (const e of dirs[rel] ?? []) {
      if (e.dir) {
        const isOpen = open.has(e.path) || (!!q && !!dirs[e.path])
        // While filtering, a folder shows when its name or something already listed inside it matches.
        if (q && !matches(e) && !hasMatch(e.path)) continue
        rows.push(
          <TreeRow key={e.path} entry={e} depth={depth} open={isOpen} mark={changedDirs.has(e.path)} onClick={() => toggle(e.path)} />
        )
        if (isOpen) walk(e.path, depth + 1)
      } else if (matches(e)) {
        rows.push(
          <TreeRow key={e.path} entry={e} depth={depth} mark={changed.has(e.path)} active={selected === e.path} onClick={() => setSelected(e.path)} />
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
              <button key={c.path} className={'tree-row change' + (selected === c.path ? ' active' : '') + (c.exists === false ? ' gone' : '')} onClick={() => c.exists !== false && setSelected(c.path)}>
                <FileIcon name={c.path} />
                <span className="tree-name">{c.path}</span>
                <span className="tree-meta">{c.exists === false ? t('已删除') : c.kind === 'move' ? t('已移动') : t('已修改')} · {relTime(c.changedAt)}</span>
              </button>
            ))
          ) : (
            <div className="files-note">{t('agent 还没有改过这个文件夹里的文件。')}</div>
          )
        ) : rows.length ? (
          rows
        ) : (
          q ? <div className="files-note">{t('没有匹配的文件')}</div> : (
            <div className="empty">
              <FolderOpen size={22} />
              <div>{t('文件夹是空的。')}</div>
              <div className="small">{t('agent 写的文件和您添加的文件会出现在这里。')}</div>
            </div>
          )
        )}
      </div>
    </div>
  )

  const preview = selected ? (
    <FilePreview id={id} path={selected} root={root} entry={findEntry(dirs, selected)} change={changed.get(selected)} onBack={narrow ? () => setSelected(null) : undefined} />
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
        <button className="icon-btn sm" data-tip={t('添加文件')} aria-label={t('添加文件')} onClick={() => picker.current?.click()}>
          <Plus size={15} />
        </button>
        <button className="icon-btn sm" data-tip={t('刷新')} aria-label={t('刷新')} onClick={reload}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn sm" data-tip={t('在文件管理器中打开')} aria-label={t('在文件管理器中打开')} onClick={() => void api().openLibraryPath(id, '').then((r) => !r.ok && r.error && toast(r.error, 'error'))}>
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
        {(!narrow || !selected) && list}
        {(!narrow || selected) && preview}
      </div>
    </div>
  )
}

function findEntry(dirs: Record<string, LibraryEntry[]>, path: string): LibraryEntry | undefined {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return dirs[parent]?.find((e) => e.path === path)
}

function TreeRow({ entry, depth, open, mark, active, onClick }: { entry: LibraryEntry; depth: number; open?: boolean; mark?: boolean; active?: boolean; onClick: () => void }) {
  return (
    <button className={'tree-row' + (active ? ' active' : '')} style={{ '--depth': depth } as React.CSSProperties} onClick={onClick} aria-expanded={entry.dir ? !!open : undefined}>
      {entry.dir ? open ? <ChevronDown size={14} className="tree-caret" /> : <ChevronRight size={14} className="tree-caret" /> : <span className="tree-caret" />}
      {entry.dir ? <Folder size={15} className="muted" /> : <FileIcon name={entry.name} />}
      <span className="tree-name">{entry.name}</span>
      {mark && <span className="tree-mark" data-tip={t('agent 改过')} />}
    </button>
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

function FilePreview({ id, path, root, entry, change, onBack }: { id: string; path: string; root: string; entry?: LibraryEntry; change?: LibraryChange; onBack?: () => void }) {
  const [file, setFile] = useState<Awaited<ReturnType<ReturnType<typeof api>['readLibraryFile']>> | null>(null)
  const [rendered, setRendered] = useState(true)
  useEffect(() => {
    setFile(null)
    void api().readLibraryFile(id, path).then((f) => setFile(f ?? undefined))
  }, [id, path, change?.changedAt, entry?.updatedAt])
  const name = path.split('/').pop() ?? path
  const md = /\.(md|markdown)$/i.test(name)
  const openWith = (reveal: boolean) => void api().openLibraryPath(id, path, reveal).then((r) => !r.ok && r.error && toast(r.error, 'error'))
  return (
    <div className="files-preview">
      <div className="preview-head">
        {onBack && (
          <button className="icon-btn sm" aria-label={t('返回文件列表')} data-tip={t('返回文件列表')} onClick={onBack}>
            <ArrowLeft size={15} />
          </button>
        )}
        <div className="preview-title">
          <span className="preview-name" data-tip={`${root}/${path}`}>{name}</span>
          <span className="small muted">
            {[file?.size !== undefined ? humanSize(file.size) : '', entry ? relTime(entry.updatedAt) : '', change ? t('agent 改过') : ''].filter(Boolean).join(' · ')}
          </span>
        </div>
        <span className="spacer" />
        {md && file?.text !== undefined && (
          <button className="pill-btn" onClick={() => setRendered(!rendered)}>
            {rendered ? t('源码') : t('预览')}
          </button>
        )}
        <button className="icon-btn sm" data-tip={t('用默认应用打开')} aria-label={t('用默认应用打开')} onClick={() => openWith(false)}>
          <ExternalLink size={14} />
        </button>
        <button className="icon-btn sm" data-tip={t('在文件夹中显示')} aria-label={t('在文件夹中显示')} onClick={() => openWith(true)}>
          <FolderOpen size={14} />
        </button>
      </div>
      <div className="preview-body">
        {file === null ? null : file === undefined ? (
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
