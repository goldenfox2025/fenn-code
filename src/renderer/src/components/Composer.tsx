import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, SlidersHorizontal, CornerDownLeft, FileText, Folder, FolderGit2, FolderKanban, FolderOpen, Plus, Square, X } from 'lucide-react'
import type { Attachment, Conversation, FolderCandidate } from '@shared/model'
import type { SessionOption } from '@shared/contract'
import { api, refreshAccount, toast, useApp } from '../store'
import { useMenu, type MenuItem } from './Menu'
import { lang, t } from '../i18n'

interface Props {
  conversation?: Conversation
  placeholder?: string
  autoFocus?: boolean
  /** For a not-yet-created chat: called with the text instead of sending. */
  onSubmit?: (text: string, attachments: Attachment[], optionValues?: Record<string, string>) => void
  /** Extra controls rendered on the left of the bottom row. */
  leading?: React.ReactNode
  /** Backend picker for a new chat. */
  backendId?: string
  onBackendChange?: (id: string) => void
  /** Model picker for a new chat (from the backend's remembered model list). */
  modelId?: string
  onModelChange?: (id: string) => void
  /** Working folder for a not-yet-created chat ('' = none). */
  folder?: string
  onFolderChange?: (folder: string) => void
  /**
   * 'card': tall box with controls inside (chats, home).
   * 'line': single-line box with controls underneath (project chat, threads), as in Claude Projects.
   */
  variant?: 'card' | 'line'
}

const MAX_TEXT_FILE = 1_000_000
const MAX_IMAGE = 8_000_000

export function Composer({ conversation, placeholder, autoFocus, onSubmit, leading, backendId, onBackendChange, modelId, onModelChange, folder, onFolderChange, variant = 'card' }: Props) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const backends = useApp((s) => s.backends)
  const accounts = useApp((s) => s.accounts)
  // Install and sign-in state for the picker's hints (checked at most once a minute).
  useEffect(() => {
    for (const b of backends) if (b.account) void refreshAccount(b.id, 60_000)
  }, [backends])
  const [menu, openMenu] = useMenu({ placement: 'above', align: 'right' })
  const hasPermission = useApp((s) => !!conversation && s.permissions.some((p) => p.conversationId === conversation.id))
  const busy = conversation?.status === 'working' || hasPermission
  const draftKey = conversation ? `draft:${conversation.id}` : 'draft:new'

  useEffect(() => {
    setText(sessionStorage.getItem(draftKey) ?? '')
    setFiles([])
    if (autoFocus) ta.current?.focus()
  }, [draftKey, autoFocus])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  const addFiles = async (list: FileList | File[]) => {
    const next: Attachment[] = []
    for (const f of Array.from(list)) {
      try {
        next.push(await readAttachment(f))
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error')
      }
    }
    if (next.length) setFiles((cur) => [...cur, ...next])
  }

  const submit = () => {
    const t = text.trim()
    if (!t && !files.length) return
    setText('')
    setFiles([])
    sessionStorage.removeItem(draftKey)
    if (onSubmit) onSubmit(t, files, Object.keys(pending).length ? pending : undefined)
    else if (conversation) void api().send(conversation.id, t, files)
  }

  const currentBackend = backends.find((b) => b.id === (conversation?.backendId ?? backendId))
  // Before a chat's first reply its own model list isn't known yet; use the one its backend offered last time.
  const remembered = useApp((s) => s.settings.backendModels?.[conversation?.backendId ?? backendId ?? ''])
  const models = conversation?.models?.length ? conversation.models : (remembered?.models ?? [])
  const wanted = conversation ? (conversation.modelId ?? remembered?.current) : (modelId ?? remembered?.current)
  const currentModel = models.find((m) => m.id === wanted) ?? (conversation?.models?.length ? undefined : models[0])
  const canSend = !!text.trim() || files.length > 0
  // The session's other choices (mode, thinking level); before a session, the backend's last list and the defaults.
  const bid = conversation?.backendId ?? backendId ?? ''
  const defaults = useApp((s) => s.settings.backendOptionDefaults?.[bid])
  const options: SessionOption[] = conversation?.sessionOptions?.length ? conversation.sessionOptions : (remembered?.options ?? [])
  // A mode picked before the first message belongs to that chat only, not to every later one.
  const [pending, setPending] = useState<Record<string, string>>({})
  useEffect(() => setPending({}), [bid])
  const valueOf = (o: SessionOption) =>
    conversation?.sessionOptions?.length ? o.current : (conversation?.optionValues?.[o.id] ?? pending[o.id] ?? (o.category === 'mode' ? undefined : defaults?.[o.id]) ?? o.current)
  const modeOpt = options.find((o) => o.category === 'mode')
  const modeValue = modeOpt && valueOf(modeOpt)
  const modeNote = modeOpt && modeValue && modeValue !== modeOpt.choices[0]?.value ? choiceLabel(modeOpt.choices.find((c) => c.value === modeValue)?.name ?? modeValue) : ''

  const accountHint = (id: string): string | undefined => {
    const a = accounts[id]
    if (a?.installed === false) return t('未安装')
    if (a?.signedIn === false) return t('未登录')
    return undefined
  }
  const pickerItems = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (models.length && (conversation || onModelChange)) {
      items.push({ heading: t('模型') })
      for (const m of models)
        items.push({
          label: m.name,
          sub: m.description,
          checked: m.id === currentModel?.id,
          onClick: () => (conversation ? api().setModel(conversation.id, m.id) : onModelChange?.(m.id))
        })
    }
    if (conversation || onModelChange)
      for (const o of options) {
        items.push({ heading: optionLabel(o) })
        const now = valueOf(o)
        for (const c of o.choices) {
          const label = choiceLabel(c.name)
          items.push({
            label,
            sub: label !== c.name ? c.name : c.description,
            checked: c.value === now,
            onClick: () => {
              if (!conversation) {
                if (o.category === 'mode') return setPending((p) => ({ ...p, [o.id]: c.value }))
                return void api().setOptionDefault(bid, o.id, c.value)
              }
              void api().setOption(conversation.id, o.id, c.value)
              // A thinking level carries over to new chats; a mode stays with this conversation.
              if (o.category !== 'mode') void api().setOptionDefault(bid, o.id, c.value)
            }
          })
        }
      }
    if (!conversation && onBackendChange) {
      // Only backends that can answer; installing and signing in live in Settings.
      const usable = backends.filter((b) => !accountHint(b.id))
      items.push({ heading: usable.length ? t('Agent 后端') : t('还没有可用的 Agent 后端，请在设置里安装或登录') })
      for (const b of usable) items.push({ label: b.name, sub: b.description, checked: b.id === backendId, onClick: () => onBackendChange(b.id) })
    }
    if (conversation && !models.length)
      items.push({
        heading: conversation.sessionRef
          ? t('{0} 没有提供模型选择', currentBackend?.name ?? '')
          : t('{0}：发送第一条消息后可选择模型', currentBackend?.name ?? '')
      })
    const manage = () => useApp.getState().set({ settingsOpen: 'backends' })
    items.push({ separator: true })
    items.push({ icon: <SlidersHorizontal size={15} />, label: t('管理 Agent 后端…'), onClick: manage })
    return items
  }

  const modelButton = (
    <button
      className="select-btn"
      onClick={(e) => {
        e.stopPropagation()
        openMenu(e.currentTarget, pickerItems())
      }}
    >
      {currentModel?.name ?? currentBackend?.name ?? t('选择后端')}
      {modeNote && <span className="mode-note"> · {modeNote}</span>}
      {currentBackend && accountHint(currentBackend.id) && <span className="mode-note warn"> · {accountHint(currentBackend.id)}</span>}
      <ChevronDown size={14} />
    </button>
  )
  // The working folder: a project's own for its chat and threads, else the conversation's.
  const project = useApp((s) => s.projects.find((p) => p.id === conversation?.projectId))
  const ownsFolder = conversation && conversation.kind !== 'chat' && project
  const folderNow = conversation ? (ownsFolder ? project.cwd : conversation.cwd) || '' : (folder ?? '')
  const setFolder = (f: string) => {
    if (!conversation) return onFolderChange?.(f)
    if (ownsFolder) void api().updateProject(project.id, { cwd: f })
    else void api().updateConversation(conversation.id, { cwd: f })
  }
  const canSetFolder = !!(conversation || onFolderChange)
  const folderChip = canSetFolder && <FolderChip folder={folderNow} onChange={setFolder} hint={project?.name || conversation?.title || text} />
  // A folder path typed into the message is offered as the working folder; never set without asking.
  const [mention, setMention] = useState<string | null>(null)
  useEffect(() => setMention(null), [draftKey])
  useEffect(() => {
    if (!canSetFolder || !text.trim()) return
    if (!/[\\/]/.test(text)) return setMention(null)
    const h = setTimeout(async () => {
      const found = (await api().foldersInText(text).catch(() => [])).find((f) => f !== folderNow && !dismissedFolders.has(f))
      setMention(found ?? null)
    }, 400)
    return () => clearTimeout(h)
  }, [text, folderNow, canSetFolder])
  const folderHint = mention && mention !== folderNow && (
    <div className="folder-hint">
      <Folder size={15} />
      <span className="grow" title={mention}>
        {t('消息里提到了文件夹「{0}」', baseName(mention))}
        <span className="muted"> · {mention}</span>
      </span>
      <button
        className="btn"
        onClick={(e) => {
          e.stopPropagation()
          setFolder(mention)
          setMention(null)
        }}
      >
        {ownsFolder ? t('设为项目文件夹') : t('设为工作文件夹')}
      </button>
      <button
        className="icon-btn sm"
        title={t('不用')}
        onClick={(e) => {
          e.stopPropagation()
          dismissedFolders.add(mention)
          setMention(null)
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
  const attachButton = (
    <button className="icon-btn" title={t('添加文件或图片')} onClick={(e) => (e.stopPropagation(), picker.current?.click())}>
      <Plus size={18} />
    </button>
  )
  const sendButton =
    busy && !canSend ? (
      <button className="send-btn stop" title={t('停止')} onClick={() => conversation && api().cancel(conversation.id)}>
        <Square size={12} fill="currentColor" />
      </button>
    ) : variant === 'line' ? (
      <button className="icon-btn" disabled={!canSend} onClick={submit} title={t('发送 (Enter)')}>
        <CornerDownLeft size={17} />
      </button>
    ) : (
      <button className="send-btn" disabled={!canSend} onClick={submit} title={t('发送 (Enter)')}>
        <ArrowUp size={18} />
      </button>
    )

  return (
    <div className={'composer-wrap v-' + variant}>
      {busy && conversation && <WorkingTimer conversationId={conversation.id} />}
      <div
        className={'composer' + (dragging ? ' dragging' : '')}
        onClick={() => ta.current?.focus()}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void addFiles(e.dataTransfer.files)
        }}
      >
        {folderHint}
        {files.length > 0 && (
          <div className="attach-row">
            {files.map((f, i) => (
              <AttachmentChip key={i} a={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="composer-input">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={placeholder ?? (busy ? t('继续输入，消息会在当前回复结束后发送') : t('回复…'))}
            onChange={(e) => {
              setText(e.target.value)
              sessionStorage.setItem(draftKey, e.target.value)
            }}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files)
              if (imgs.length) {
                e.preventDefault()
                void addFiles(imgs)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {variant === 'line' && sendButton}
        </div>
        {variant === 'card' && (
          <div className="composer-row">
            {attachButton}
            {folderChip}
            {leading}
            <span className="spacer" />
            {modelButton}
            {sendButton}
          </div>
        )}
      </div>
      {variant === 'line' && (
        <div className="composer-under">
          {attachButton}
          {folderChip}
          {leading}
          <span className="spacer" />
          {modelButton}
        </div>
      )}
      {menu}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Time since the current reply started, like Claude's "Working… 12s". */
function WorkingTimer({ conversationId }: { conversationId: string }) {
  const since = useApp((s) => {
    const list = s.messages[conversationId] ?? []
    for (let i = list.length - 1; i >= 0; i--) if (list[i].state === 'streaming') return list[i].createdAt
    return undefined
  })
  // A hidden turn is the app's own bookkeeping (saving memory before a handoff).
  const housekeeping = useApp((s) => {
    const list = s.messages[conversationId] ?? []
    for (let i = list.length - 1; i >= 0; i--) if (list[i].state === 'streaming') return !!list[i].hidden
    return false
  })
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (since === undefined) return null
  const s = Math.max(0, Math.round((Date.now() - since) / 1000))
  return (
    <div className="working-timer">
      <span className="dot working" />
      {housekeeping ? t('正在整理项目记忆') : t('正在处理')} {s < 60 ? t('{0} 秒', s) : t('{0} 分 {1} 秒', Math.floor(s / 60), s % 60)}
    </div>
  )
}

export function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  return (
    <div className="attach-chip" title={a.name}>
      {a.kind === 'image' && a.data ? (
        <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
      ) : (
        <span className="attach-icon">
          <FileText size={16} />
        </span>
      )}
      <span className="attach-name">{a.name}</span>
      {onRemove && (
        <button className="icon-btn sm" onClick={(e) => (e.stopPropagation(), onRemove())}>
          <X size={12} />
        </button>
      )}
    </div>
  )
}

async function readAttachment(f: File): Promise<Attachment> {
  const path = (window as unknown as { ancoraFilePath?: (f: File) => string }).ancoraFilePath?.(f)
  if (f.type.startsWith('image/')) {
    if (f.size > MAX_IMAGE) throw new Error(t('{0} 太大（图片上限 8 MB）', f.name))
    const buf = new Uint8Array(await f.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { name: f.name || t('粘贴的图片.png'), mimeType: f.type, size: f.size, kind: 'image', data: btoa(bin), path }
  }
  if (f.size > MAX_TEXT_FILE) throw new Error(t('{0} 太大（文本文件上限 1 MB）', f.name))
  const text = await f.text()
  // Reject binary files: they would arrive as garbage.
  if (/\u0000/.test(text.slice(0, 4000))) throw new Error(t('{0} 不是文本文件，暂时只支持文本和图片', f.name))
  return { name: f.name, mimeType: f.type || 'text/plain', size: f.size, kind: 'file', text, path }
}

export function ProjectPicker({ projectId, onChange }: { projectId?: string; onChange: (id?: string) => void }) {
  const projects = useApp((s) => s.projects)
  const [menu, openMenu] = useMenu({ placement: 'below' })
  const current = projects.find((p) => p.id === projectId)
  return (
    <>
      <button
        className="select-btn"
        onClick={(e) => {
          e.stopPropagation()
          openMenu(e.currentTarget, [
            { label: t('不放入项目（自动归类）'), checked: !projectId, onClick: () => onChange(undefined) },
            ...(projects.length ? [{ separator: true } as MenuItem] : []),
            ...projects.filter((p) => !p.archived || p.id === projectId).map((p) => ({ label: p.name, checked: p.id === projectId, onClick: () => onChange(p.id) }))
          ])
        }}
      >
        <FolderKanban size={15} />
        {current?.name ?? t('项目')}
        <ChevronDown size={13} />
      </button>
      {menu}
    </>
  )
}

function optionLabel(o: SessionOption): string {
  if (o.category === 'mode') return t('权限模式')
  if (o.category === 'thought_level') return t('思考强度')
  return o.name
}

/** Common English names agents give their modes and levels, in Chinese when the UI is. */
const CHOICE_ZH: Record<string, string> = {
  default: '每次询问', // i18n-ignore
  'accept edits': '自动接受编辑', // i18n-ignore
  auto: '自动判断', // i18n-ignore
  "don't ask": '不询问，直接拒绝', // i18n-ignore
  'bypass permissions': '全部允许', // i18n-ignore
  plan: '只做计划', // i18n-ignore
  'plan mode': '只做计划', // i18n-ignore
  minimal: '最低', // i18n-ignore
  low: '低', // i18n-ignore
  medium: '中', // i18n-ignore
  high: '高', // i18n-ignore
  max: '最高', // i18n-ignore
  xhigh: '很高' // i18n-ignore
}
function choiceLabel(name: string): string {
  if (lang !== 'zh') return name
  const m = name.match(/^(.*?)(\s*\(default\))?$/i)
  const zh = CHOICE_ZH[(m?.[1] ?? name).trim().toLowerCase()]
  return zh ? zh + (m?.[2] ? '（默认）' : '') : name // i18n-ignore
}

/** Folders the user said no to in this session. */
const dismissedFolders = new Set<string>()

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

/**
 * The conversation's working folder, like Claude's folder picker. With a
 * folder the agent can read and change files and run commands there; without
 * one it works in a private scratch space and asks before touching any file.
 */
export function FolderChip({ folder, onChange, hint = '' }: { folder: string; onChange: (folder: string) => void; hint?: string }) {
  const [menu, openMenu] = useMenu({ placement: 'above' })
  const recent = useApp((s) => {
    // The folder set in Settings comes first, as a suggestion only.
    const seen = new Set<string>(s.settings.defaultCwd ? [s.settings.defaultCwd] : [])
    for (const f of s.settings.recentFolders ?? []) seen.add(f)
    for (const c of [...s.conversations].sort((a, b) => b.updatedAt - a.updatedAt)) if (c.cwd) seen.add(c.cwd)
    for (const p of s.projects) if (p.cwd) seen.add(p.cwd)
    return [...seen].slice(0, 6).join('\n')
  })
  const choose = async () => {
    const dir = await api().pickFolder()
    if (dir) onChange(dir)
  }
  return (
    <>
      <button
        className={'select-btn folder-chip' + (folder ? ' on' : '')}
        title={folder ? t('工作文件夹：{0}', folder) : t('选择工作文件夹，让 agent 能读写其中的文件、运行命令')}
        onClick={async (e) => {
          e.stopPropagation()
          const el = e.currentTarget
          const others = recent.split('\n').filter((f) => f && f !== folder)
          // Likely project folders, found by a quick scan the app caches; the menu doesn't wait long for it.
          const found = await Promise.race([
            api().suggestFolders(hint).catch(() => [] as FolderCandidate[]),
            new Promise<FolderCandidate[]>((r) => setTimeout(() => r([]), 1200))
          ])
          const likely = found.filter((f) => f.path !== folder && !others.includes(f.path)).slice(0, 5)
          openMenu(el, [
            ...(folder ? [{ heading: folder }, { separator: true } as MenuItem] : []),
            { icon: <FolderOpen size={15} />, label: t('选择文件夹…'), onClick: () => void choose() },
            ...(others.length ? [{ heading: t('最近使用') } as MenuItem] : []),
            ...others.map((f) => ({ icon: <Folder size={15} />, label: baseName(f), sub: f, onClick: () => onChange(f) })),
            ...(likely.length ? [{ heading: t('可能的项目文件夹') } as MenuItem] : []),
            ...likely.map((f) => ({ icon: <FolderGit2 size={15} />, label: f.name, sub: f.path, onClick: () => onChange(f.path) })),
            ...(folder ? [{ separator: true } as MenuItem, { icon: <X size={15} />, label: t('不使用文件夹'), onClick: () => onChange('') }] : [])
          ])
        }}
      >
        <Folder size={15} />
        <span className="dropdown-value">{folder ? baseName(folder) : t('文件夹')}</span>
      </button>
      {menu}
    </>
  )
}
