import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, CornerDownLeft, FileText, Folder, FolderGit2, FolderKanban, FolderOpen, Plus, Square, X } from 'lucide-react'
import type { Attachment, Conversation, FolderCandidate } from '@shared/model'
import type { SessionOption } from '@shared/contract'
import { api, refreshAccount, toast, useApp } from '../store'
import { useMenu, type MenuItem } from './Menu'
import { t } from '../i18n'
import { choiceLabel, optionLabel } from './sessionOptionLabels'
import { sessionOptionDefaults, visibleSessionOptions } from '@shared/sessionOptions'
import { backendAvailable } from '@shared/backendAvailability'
import { EffortPicker } from './EffortPicker'
import { ContextRing } from './Usage'

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
  const [menu, openMenu, updateMenu] = useMenu({ placement: 'above', align: 'right', compact: true })
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
    if (selecting) return
    const t = text.trim()
    if (!t && !files.length) return
    setText('')
    setFiles([])
    sessionStorage.removeItem(draftKey)
    if (onSubmit) onSubmit(t, files, Object.keys(pending).length ? pending : undefined)
    else if (conversation) void api().send(conversation.id, t, files)
  }

  const bid = conversation?.backendId ?? backendId ?? ''
  const currentBackend = backends.find((b) => b.id === bid)
  // Before a chat's first reply its own model list isn't known yet; use the one its backend offered last time.
  const settings = useApp((s) => s.settings)
  const remembered = settings.backendModels?.[bid]
  const savedModel = settings.backendModelDefaults?.[bid]
  const models = conversation?.models?.length ? conversation.models : (remembered?.models ?? [])
  const wanted = (conversation ? conversation.modelId : modelId) ?? savedModel ?? remembered?.current
  const currentModel = models.find((m) => m.id === wanted) ?? models.find((m) => m.id === remembered?.current) ?? models[0]
  // The session's other choices (mode, thinking level); before a session, the backend's last list and the defaults.
  const defaults = sessionOptionDefaults(settings, bid, currentModel?.id)
  const options = visibleSessionOptions(conversation?.sessionOptions ?? remembered?.options ?? [], currentBackend?.optionPolicy)
  // A mode picked before the first message belongs to that chat only, not to every later one.
  const [pending, setPending] = useState<Record<string, string>>({})
  useEffect(() => setPending({}), [bid, conversation?.id])
  const valueOf = (o: SessionOption) => {
    const v = conversation?.sessionOptions !== undefined ? o.current : (conversation?.optionValues?.[o.id] ?? pending[o.id] ?? (o.category === 'mode' ? undefined : defaults[o.id]) ?? o.current)
    return o.choices.some((c) => c.value === v) ? v : o.current
  }
  const modeOpt = options.find((o) => o.category === 'mode')
  const modeValue = modeOpt && valueOf(modeOpt)
  const modeNote = modeOpt && modeValue && modeValue !== modeOpt.choices[0]?.value ? choiceLabel(modeOpt.choices.find((c) => c.value === modeValue)?.name ?? modeValue, modeValue) : ''
  // Thinking level gets its own slider beside the model, like Claude's effort control.
  const effortOpt = options.find((o) => o.category === 'thought_level' || (!o.category && /reasoning|effort|thinking/i.test(o.id)))

  // Set below once the model probe has answered: an agent that refused because it is signed out.
  const catalogFor = useRef<{ id: string; needsLogin?: boolean }>({ id: '' })
  // What the account check says; the model probe can also find an agent signed out.
  const accountState = (id: string): string | undefined => {
    const b = backends.find((x) => x.id === id)
    if ((accounts[id]?.installed ?? b?.installed) === false) return t('未安装')
    if (accounts[id]?.signedIn === false) return t('未登录')
    return undefined
  }
  const accountHint = (id: string): string | undefined =>
    accountState(id) ?? (id === catalogFor.current.id && catalogFor.current.needsLogin ? t('未登录') : undefined)

  // Connect to the agent while the user reads or types, so pressing Enter only sends (no prompt is sent here).
  const ready = !!conversation && !!currentBackend && !accountHint(bid)
  useEffect(() => {
    if (ready && conversation && !busy) void api().prepareConversation(conversation.id).catch(() => undefined)
  }, [conversation?.id, bid, ready])

  // The models a backend offers, read from a fresh session before the first message (no prompt is sent).
  const [catalog, setCatalog] = useState<{ for: string; loading: boolean; error?: string; needsLogin?: boolean }>({ for: '', loading: false })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    const known = models.length > 0 && (!wanted || remembered?.current === wanted || !!conversation?.sessionRef)
    if (!bid || busy || accountState(bid) || known) return setCatalog({ for: bid, loading: false })
    setCatalog({ for: bid, loading: true })
    api()
      .backendModels(bid, wanted)
      .then(
        (c) => live && setCatalog({ for: bid, loading: false, needsLogin: c.needsLogin }),
        (e) => live && setCatalog({ for: bid, loading: false, error: e instanceof Error ? e.message : String(e) })
      )
    return () => {
      live = false
    }
  }, [bid, wanted, conversation?.id, conversation?.sessionRef?.sessionId, busy, currentBackend?.installed, accounts[bid]?.signedIn, retry])
  const loadingModels = catalog.loading || catalog.for !== bid
  catalogFor.current = { id: catalog.for, needsLogin: catalog.needsLogin }

  // One choice at a time; the message waits until it has been applied.
  const [selecting, setSelecting] = useState(false)
  const canSend = !selecting && (!!text.trim() || files.length > 0)
  const choose = async (op: () => Promise<unknown>) => {
    if (selecting) return
    setSelecting(true)
    try {
      await op()
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    } finally {
      setSelecting(false)
    }
  }

  const setOptionValue = (o: SessionOption, value: string) => {
    if (!conversation && o.category === 'mode') return setPending((p) => ({ ...p, [o.id]: value }))
    // A thinking level carries over to new chats (the app remembers it); a mode stays with this conversation.
    void choose(() => (conversation ? api().setOption(conversation.id, o.id, value) : api().setOptionDefault(bid, o.id, value)))
  }

  const canPick = !!(conversation || onModelChange)
  const canSwitch = !!(conversation || onBackendChange)
  const manageItem: MenuItem = { label: t('管理 Agent 后端…'), onClick: () => useApp.getState().set({ settingsOpen: 'backends' }) }
  const signedOut = !!currentBackend && accountHint(bid) === t('未登录')

  // As in Claude's model menu: a few items with a check or a number key, the rest one level down.
  const SHOWN = 4
  const firstFew = <T,>(list: T[], current: (x: T) => boolean): [T[], T[]] => {
    if (list.length <= SHOWN + 1) return [list, []]
    const top = list.slice(0, SHOWN)
    const cur = list.find(current)
    if (cur && !top.includes(cur)) top[SHOWN - 1] = cur
    return [top, list.filter((x) => !top.includes(x))]
  }

  // The agent: installed ones only (installing and signing in live in Settings). An idle chat can
  // change agent; the new one gets the conversation so far.
  const backendItems = (): MenuItem[] => {
    const usable = backends.filter((b) => b.id === bid || backendAvailable(b, accounts[b.id]))
    const pick = (id: string) => {
      if (id === bid) return
      if (conversation) void choose(() => api().updateConversation(conversation.id, { backendId: id }))
      else onBackendChange?.(id)
    }
    const [top, rest] = firstFew(usable, (b) => b.id === bid)
    const items: MenuItem[] = top.map((b, i) => ({ label: b.name, checked: b.id === bid, shortcut: String(i + 1), disabled: busy, onClick: () => pick(b.id) }))
    if (!usable.length) items.push({ label: t('还没有可用的 Agent 后端'), info: true })
    if (rest.length) items.push({ separator: true }, { label: t('更多后端'), submenu: rest.map((b) => ({ label: b.name, checked: false, disabled: busy, onClick: () => pick(b.id) })) })
    items.push({ separator: true }, manageItem)
    return items
  }

  // The current agent's models; its permission modes one level down.
  const modelItems = (): MenuItem[] => {
    const items: MenuItem[] = []
    if (signedOut) items.push({ label: t('{0} 还没登录', currentBackend!.name), hint: t('去登录'), onClick: manageItem.onClick })
    else if (!models.length) {
      if (loadingModels) items.push({ label: t('正在加载模型…'), info: true })
      else if (catalog.error) items.push({ label: t('无法加载模型列表'), hint: t('重试'), onClick: () => setRetry((n) => n + 1) })
    }
    const setModel = (id: string) =>
      void choose(async () => {
        if (conversation) return api().setModel(conversation.id, id)
        await api().setModelDefault(bid, id)
        onModelChange?.(id)
      })
    const [top, rest] = firstFew(models, (m) => m.id === currentModel?.id)
    top.forEach((m, i) => items.push({ label: m.name, checked: m.id === currentModel?.id, shortcut: String(i + 1), disabled: busy, onClick: () => setModel(m.id) }))
    const more: MenuItem[] = []
    if (rest.length) more.push({ label: t('更多模型'), submenu: rest.map((m) => ({ label: m.name, checked: false, disabled: busy, onClick: () => setModel(m.id) })) })
    for (const o of options) {
      if (o === effortOpt) continue
      const now = valueOf(o)
      more.push({
        label: optionLabel(o),
        hint: choiceLabel(o.choices.find((c) => c.value === now)?.name ?? '', now),
        submenu: o.choices.map((c) => ({ label: choiceLabel(c.name, c.value), checked: c.value === now, disabled: busy, onClick: () => setOptionValue(o, c.value) }))
      })
    }
    if (more.length && items.length) items.push({ separator: true })
    items.push(...more)
    return items
  }
  // An open menu shows the models as soon as they arrive.
  useEffect(() => updateMenu(menuFor.current === 'model' ? modelItems() : backendItems()), [models.length, loadingModels, catalog.error, catalog.needsLogin, bid])
  const menuFor = useRef<'model' | 'backend'>('model')
  const open = (which: 'model' | 'backend', el: HTMLElement) => {
    menuFor.current = which
    openMenu(el, which === 'model' ? modelItems() : backendItems())
  }

  const showModel = canPick && (models.length > 0 || loadingModels || !!catalog.error || signedOut)
  const modelButton = (
    <span className="model-group">
      {canSwitch && (
        <button className="footer-chip backend-chip" aria-haspopup="menu" data-tip={t('Agent 后端')} onClick={(e) => (e.stopPropagation(), open('backend', e.currentTarget))}>
          {currentBackend?.name ?? t('选择后端')}
        </button>
      )}
      {showModel && (
        <button
          className="footer-chip select-btn model-btn"
          aria-haspopup="menu"
          aria-busy={loadingModels || selecting}
          data-tip={t('模型')}
          onClick={(e) => (e.stopPropagation(), open('model', e.currentTarget))}
        >
          {signedOut ? <span className="mode-note warn">{t('未登录')}</span> : (currentModel?.name ?? <span className="muted">{t('模型')}</span>)}
          {modeNote && <span className="mode-note"> · {modeNote}</span>}
        </button>
      )}
      {effortOpt && canPick && !signedOut && (
        <EffortPicker option={effortOpt} value={valueOf(effortOpt)} disabled={busy} onChange={(v) => setOptionValue(effortOpt, v)} />
      )}
      {conversation ? (
        <ContextRing usage={conversation.usage} timing={conversation.timing} scope={conversation.kind === 'thread' ? t('本讨论串用量') : t('本对话用量')} />
      ) : null}
    </span>
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
      <span className="grow" data-tip={mention}>
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
        data-tip={t('不用')}
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
    <button className="icon-btn" data-tip={t('添加文件或图片')} onClick={(e) => (e.stopPropagation(), picker.current?.click())}>
      <Plus size={18} />
    </button>
  )
  const sendButton =
    busy && !canSend ? (
      <button className="send-btn stop" data-tip={t('停止')} onClick={() => conversation && api().cancel(conversation.id)}>
        <Square size={12} fill="currentColor" />
      </button>
    ) : variant === 'line' ? (
      <button className="icon-btn" disabled={!canSend} onClick={submit} data-tip={t('发送 (Enter)')}>
        <CornerDownLeft size={17} />
      </button>
    ) : (
      <button className="send-btn" disabled={!canSend} onClick={submit} data-tip={t('发送 (Enter)')}>
        <ArrowUp size={18} />
      </button>
    )

  return (
    <div className={'composer-wrap v-' + variant}>
      {busy && conversation && <HousekeepingTimer conversationId={conversation.id} />}
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
/** A hidden turn (saving project memory before a handoff) has no message to show its working mark in. */
function HousekeepingTimer({ conversationId }: { conversationId: string }) {
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
  if (since === undefined || !housekeeping) return null
  const s = Math.max(0, Math.round((Date.now() - since) / 1000))
  return (
    <div className="working-timer">
      <span className="dot working" />
      {t('正在整理项目记忆')} {s < 60 ? t('{0} 秒', s) : t('{0} 分 {1} 秒', Math.floor(s / 60), s % 60)}
    </div>
  )
}

export function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  return (
    <div className="attach-chip" data-tip={a.name}>
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
        data-tip={folder ? t('工作文件夹：{0}', folder) : t('选择工作文件夹，让 agent 能读写其中的文件、运行命令')}
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
