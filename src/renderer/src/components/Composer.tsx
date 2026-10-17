import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { errorText } from '@shared/errors'
import { ArrowUp, ChevronDown, CornerUpRight, FileText, Folder, FolderGit2, FolderOpen, GitBranch, MessagesSquare, Plus, ScrollText, Settings2, Square, SquareTerminal, X } from 'lucide-react'
import type { Attachment, Conversation, FolderCandidate } from '@shared/model'
import type { SessionOption } from '@shared/contract'
import { api, refreshAccount, toast, useApp, toastError } from '../store'
import { useMenu, type MenuItem } from './Menu'
import { lang, t } from '../i18n'
import { tk } from '@shared/i18n'
const tr = t
const NEED_TEXT = tk('请在命令后面写上要做的事')
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
}

const MAX_TEXT_FILE = 1_000_000
const MAX_IMAGE = 8_000_000

const NO_CONVERSATIONS: Conversation[] = []

export function Composer({ conversation, placeholder, autoFocus, onSubmit, leading, backendId, onBackendChange, modelId, onModelChange, folder, onFolderChange }: Props) {
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
  const [menu, openMenu, updateMenu] = useMenu({ placement: 'auto', align: 'right', compact: true })
  const hasPermission = useApp((s) => !!conversation && s.permissions.some((p) => p.conversationId === conversation.id))
  const busy = conversation?.status === 'working' || hasPermission
  const draftKey = conversation ? `draft:${conversation.id}` : 'draft:new'

  useEffect(() => {
    setText(sessionStorage.getItem(draftKey) ?? '')
    setFiles([])
    if (autoFocus) ta.current?.focus()
  }, [draftKey, autoFocus])

  // Where the caret goes once a picked command is in the box (before anything else is typed).
  const caretTo = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    if (caretTo.current !== null) {
      el.focus()
      el.setSelectionRange(caretTo.current, caretTo.current)
      caretTo.current = null
    }
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  const addFiles = async (list: FileList | File[]) => {
    const next: Attachment[] = []
    for (const f of Array.from(list)) {
      try {
        next.push(await readAttachment(f))
      } catch (e) {
        toastError(e)
      }
    }
    if (next.length) setFiles((cur) => [...cur, ...next])
  }

  const submit = () => {
    if (selecting) return
    const t = text.trim()
    // A picked command goes even without text: /compact needs none; /子对话 says what's missing.
    if (picked && conversation) {
      if (picked.app && !t) return toast(tr(NEED_TEXT), 'error')
      setText('')
      setPicked(null)
      sessionStorage.removeItem(draftKey)
      const fail = toastError
      if (picked.app) void api().runCommand(conversation.id, picked.app, t).catch(fail)
      else void api().send(conversation.id, t ? `/${picked.name} ${t}` : `/${picked.name}`).catch(fail)
      return
    }
    if (!t && !files.length) return
    const app = conversation && !target && appCommand(t, conversation)
    if (app) {
      if (!app.text) return toast(tr(NEED_TEXT), 'error')
      setText('')
      sessionStorage.removeItem(draftKey)
      void api().runCommand(conversation.id, app.command, app.text).catch(toastError)
      return
    }
    setText('')
    setFiles([])
    sessionStorage.removeItem(draftKey)
    if (target && conversation) {
      void api().sendToThread(conversation.id, target.id, t, files).catch(toastError)
      setTarget(null)
    } else if (onSubmit) onSubmit(t, files, Object.keys(pending).length ? pending : undefined)
    else if (conversation) void api().send(conversation.id, t, files)
  }

  // In a project chat, @ picks a thread: the message then goes straight to it.
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null)
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const [mentionAt, setMentionAt] = useState(0)
  useEffect(() => setTarget(null), [conversation?.id])
  // Only while @ is being typed in a project chat: the list doesn't redraw the composer otherwise.
  const allThreads = useApp((s) => (mention && conversation?.kind === 'project' ? s.conversations : NO_CONVERSATIONS))
  const mentionable =
    conversation?.kind === 'project' && mention
      ? allThreads
          .filter((c) => c.kind === 'thread' && c.projectId === conversation.projectId && c.title.toLowerCase().includes(mention.query.toLowerCase()))
          .sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || b.updatedAt - a.updatedAt)
          .slice(0, 8)
      : []
  const findMention = (value: string, caret: number) => {
    if (conversation?.kind !== 'project') return setMention(null)
    const m = /(^|[\s\p{Script=Han}\p{P}])@([^\s@]{0,24})$/u.exec(value.slice(0, caret))
    setMention(m ? { query: m[2], start: caret - m[2].length - 1, end: caret } : null)
    setMentionAt(0)
  }
  const pickMention = (th: { id: string; title: string }) => {
    if (!mention) return
    const next = text.slice(0, mention.start) + text.slice(mention.end)
    setText(next)
    sessionStorage.setItem(draftKey, next)
    setTarget({ id: th.id, title: th.title })
    setMention(null)
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(mention.start, mention.start)
    })
  }

  // / opens the commands: the app's own (a sub-conversation, a thread) and the agent's.
  // A picked command sits in the box as a chip; the text after it is its argument.
  const [picked, setPicked] = useState<SlashCommand | null>(null)
  useEffect(() => setPicked(null), [conversation?.id])
  const slashQuery = conversation && !target && !picked ? /^\/(\S*)$/.exec(text)?.[1] : undefined
  const [slashAt, setSlashAt] = useState(0)
  const [slashClosed, setSlashClosed] = useState(false)
  useEffect(() => setSlashClosed(false), [slashQuery === undefined])
  const commands = conversation ? matchCommands(slashCommands(conversation), slashQuery ?? '') : []
  const slashOpen = slashQuery !== undefined && !slashClosed && commands.length > 0
  const pickCommand = (c: SlashCommand, rest = '') => {
    setPicked(c)
    setText(rest)
    sessionStorage.setItem(draftKey, rest)
    setSlashAt(0)
    caretTo.current = rest.length
  }

  const bid = conversation?.nextBackendId ?? conversation?.backendId ?? backendId ?? ''
  // A backend picked during a reply: until the next message it has no session here, so its saved choices show.
  const staged = !!conversation?.nextBackendId
  const session = staged ? undefined : conversation
  const currentBackend = backends.find((b) => b.id === bid)
  // Before a chat's first reply its own model list isn't known yet; use the one its backend offered last time.
  const settings = useApp((s) => s.settings)
  const remembered = settings.backendModels?.[bid]
  const savedModel = settings.backendModelDefaults?.[bid]
  const models = session?.models?.length ? session.models : (remembered?.models ?? [])
  const wanted = (conversation ? session?.modelId : modelId) ?? savedModel ?? remembered?.current
  const currentModel = models.find((m) => m.id === wanted) ?? models.find((m) => m.id === remembered?.current) ?? models[0]
  // The session's other choices (mode, thinking level); before a session, the backend's last list and the defaults.
  const defaults = sessionOptionDefaults(settings, bid, currentModel?.id)
  const options = visibleSessionOptions(session?.sessionOptions ?? remembered?.options ?? [], currentBackend?.optionPolicy)
  // A mode picked before the first message belongs to that chat only, not to every later one.
  const [pending, setPending] = useState<Record<string, string>>({})
  useEffect(() => setPending({}), [bid, conversation?.id])
  const valueOf = (o: SessionOption) => {
    const v = session?.sessionOptions !== undefined ? o.current : (session?.optionValues?.[o.id] ?? pending[o.id] ?? (o.category === 'mode' ? undefined : defaults[o.id]) ?? o.current)
    return o.choices.some((c) => c.value === v) ? v : o.current
  }
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
        (e) => live && setCatalog({ for: bid, loading: false, error: errorText(e) })
      )
    return () => {
      live = false
    }
  }, [bid, wanted, conversation?.id, conversation?.sessionRef?.sessionId, busy, currentBackend?.installed, accounts[bid]?.signedIn, retry])
  const loadingModels = catalog.loading || catalog.for !== bid
  catalogFor.current = { id: catalog.for, needsLogin: catalog.needsLogin }

  // One choice at a time; the message waits until it has been applied.
  const [selecting, setSelecting] = useState(false)
  const canSend = !selecting && (!!text.trim() || files.length > 0 || !!picked)
  const choose = async (op: () => Promise<unknown>) => {
    if (selecting) return
    setSelecting(true)
    try {
      await op()
    } catch (e) {
      toastError(e)
    } finally {
      setSelecting(false)
    }
  }

  const setOptionValue = (o: SessionOption, value: string) => {
    if (!conversation && o.category === 'mode') return setPending((p) => ({ ...p, [o.id]: value }))
    // A thinking level carries over to new chats (the app remembers it); a mode stays with this conversation.
    void choose(() => (session ? api().setOption(session.id, o.id, value) : api().setOptionDefault(bid, o.id, value)))
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
    // Mid-reply the reply keeps going; the picked agent takes over with the next message.
    const cuts = (id: string) => (busy && conversation && id !== conversation.backendId && id !== bid ? t('下一条消息起换成这个') : undefined)
    const items: MenuItem[] = top.map((b, i) => ({ label: b.name, sub: cuts(b.id), checked: b.id === bid, shortcut: String(i + 1), onClick: () => pick(b.id) }))
    if (!usable.length) items.push({ label: t('还没有可用的 Agent 后端'), info: true })
    if (rest.length) items.push({ separator: true }, { label: t('更多后端'), submenu: rest.map((b) => ({ label: b.name, sub: cuts(b.id), checked: false, onClick: () => pick(b.id) })) })
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
        if (session) return api().setModel(session.id, id)
        await api().setModelDefault(bid, id)
        onModelChange?.(id)
      })
    const [top, rest] = firstFew(models, (m) => m.id === currentModel?.id)
    // Mid-reply a model change waits for the next turn; the reply keeps going.
    const later = (id: string) => (busy && session && id !== currentModel?.id ? t('下一轮生效') : undefined)
    top.forEach((m, i) => items.push({ label: m.name, sub: later(m.id), checked: m.id === currentModel?.id, shortcut: String(i + 1), onClick: () => setModel(m.id) }))
    const more: MenuItem[] = []
    if (rest.length) more.push({ label: t('更多模型'), submenu: rest.map((m) => ({ label: m.name, sub: later(m.id), checked: false, onClick: () => setModel(m.id) })) })
    for (const o of options) {
      if (o === effortOpt) continue
      const now = valueOf(o)
      more.push({
        label: optionLabel(o),
        hint: choiceLabel(o.choices.find((c) => c.value === now)?.name ?? '', now, o.category),
        submenu: o.choices.map((c) => ({ label: choiceLabel(c.name, c.value, o.category), checked: c.value === now, onClick: () => setOptionValue(o, c.value) }))
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
        <button className="footer-chip backend-chip" aria-haspopup="menu" data-tip={staged ? t('下一条消息起换成 {0}', currentBackend?.name ?? '') : t('Agent 后端')} onClick={(e) => (e.stopPropagation(), open('backend', e.currentTarget))}>
          {currentBackend?.name ?? t('选择后端')}
          <ChevronDown size={12} className="chip-caret" />
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
          <ChevronDown size={12} className="chip-caret" />
        </button>
      )}
      {effortOpt && canPick && !signedOut && (
        <EffortPicker option={effortOpt} value={valueOf(effortOpt)} onChange={(v) => setOptionValue(effortOpt, v)} />
      )}
      {conversation ? (
        <ContextRing
          usage={conversation.usage}
          timing={conversation.timing}
          scope={conversation.kind === 'thread' ? t('本讨论串用量') : t('本对话用量')}
          onCompact={conversation.compactCommand && !busy ? () => void api().compactContext(conversation.id).catch(toastError) : undefined}
        />
      ) : null}
    </span>
  )
  // The working folder: a project's own for its chat and threads, else the conversation's.
  const project = useApp((s) => s.projects.find((p) => p.id === conversation?.projectId))
  const ownsFolder = conversation && conversation.kind !== 'chat' && project
  const folderNow = conversation ? (ownsFolder ? project.cwd : conversation.cwd) || '' : (folder ?? '')
  const setFolder = (f: string) => {
    if (!conversation) return onFolderChange?.(f)
    const failed = toastError
    if (ownsFolder) void api().updateProject(project.id, { cwd: f }).catch(failed)
    else void api().updateConversation(conversation.id, { cwd: f }).catch(failed)
  }
  const canSetFolder = !!(conversation || onFolderChange)
  const folderChip = canSetFolder && <FolderChip folder={folderNow} onChange={setFolder} hint={project?.name || conversation?.title || text} />
  // A folder path typed into the message is offered as the working folder; never set without asking.
  const [folderMention, setFolderMention] = useState<string | null>(null)
  useEffect(() => setFolderMention(null), [draftKey])
  useEffect(() => {
    if (!canSetFolder || !text.trim()) return
    if (!/[\\/]/.test(text)) return setFolderMention(null)
    const h = setTimeout(async () => {
      const found = (await api().foldersInText(text).catch(() => [])).find((f) => f !== folderNow && !dismissedFolders.has(f))
      setFolderMention(found ?? null)
    }, 400)
    return () => clearTimeout(h)
  }, [text, folderNow, canSetFolder])
  const folderHint = folderMention && folderMention !== folderNow && (
    <div className="folder-hint">
      <Folder size={15} />
      <span className="grow" data-tip={folderMention}>
        {t('消息里提到了文件夹「{0}」', baseName(folderMention))}
        <span className="muted"> · {folderMention}</span>
      </span>
      <button
        className="btn"
        onClick={(e) => {
          e.stopPropagation()
          setFolder(folderMention)
          setFolderMention(null)
        }}
      >
        {ownsFolder ? t('设为项目文件夹') : t('设为工作文件夹')}
      </button>
      <button
        className="icon-btn sm"
        data-tip={t('不用')}
        onClick={(e) => {
          e.stopPropagation()
          dismissedFolders.add(folderMention)
          setFolderMention(null)
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
    ) : (
      <button className="send-btn" disabled={!canSend} onClick={submit} data-tip={t('发送 (Enter)')}>
        <ArrowUp size={18} />
      </button>
    )

  return (
    <div className="composer-wrap">
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
        {slashOpen && (
          <div className="slash-pop" role="listbox" aria-label={t('命令')}>
            {commands.map((c, i) => (
              <Fragment key={c.key}>
                {(i === 0 || !!commands[i - 1].app !== !!c.app) && (
                  <div className="slash-group">{c.app ? 'Ancora' : (currentBackend?.name ?? 'Agent')}</div>
                )}
                <button
                  role="option"
                  aria-selected={i === slashAt}
                  className={'slash-row' + (i === slashAt ? ' active' : '')}
                  ref={i === slashAt ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setSlashAt(i)}
                  onClick={() => pickCommand(c)}
                >
                  <CommandIcon c={c} />
                  <span className="slash-name">{c.name}</span>
                  {c.hint && <span className="slash-desc">{c.hint}</span>}
                </button>
              </Fragment>
            ))}
          </div>
        )}
        {mention && conversation?.kind === 'project' && (
          <div className="menu compact mention-menu" role="listbox" aria-label={t('转给讨论串')}>
            {mentionable.length ? (
              mentionable.map((th, i) => (
                <button
                  key={th.id}
                  role="option"
                  aria-selected={i === mentionAt}
                  className={'menu-item' + (i === mentionAt ? ' active' : '')}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setMentionAt(i)}
                  onClick={() => pickMention(th)}
                >
                  <MessagesSquare size={15} className="muted" />
                  <span className="menu-text">{th.title}</span>
                  {th.resolved && <span className="menu-hint">{t('已解决')}</span>}
                </button>
              ))
            ) : (
              <div className="menu-item info muted">{t('没有匹配的讨论串')}</div>
            )}
          </div>
        )}
        <div className="composer-input">
          {picked && (
            <span className="mention-chip command-chip">
              <CommandIcon c={picked} />
              {picked.name}
              <button className="icon-btn xs" aria-label={t('取消命令')} onClick={() => (setPicked(null), ta.current?.focus())}>
                <X size={12} />
              </button>
            </span>
          )}
          {target && (
            <span className="mention-chip">
              <CornerUpRight size={13} />
              {target.title}
              <button className="icon-btn xs" aria-label={t('不转给讨论串')} onClick={() => setTarget(null)}>
                <X size={12} />
              </button>
            </span>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={picked ? (picked.app === 'subchat' ? t('交给子对话做什么？') : picked.app === 'thread' ? t('让讨论串做什么？') : picked.hint ?? '') : target ? t('发给「{0}」…', target.title) : (placeholder ?? (busy ? t('继续输入，消息会在当前回复结束后发送') : t('回复…')))}
            onChange={(e) => {
              // A whole command typed by hand ("/子对话 ") turns into the chip too.
              const typed = !picked && conversation ? /^\/(\S+)\s([\s\S]*)$/.exec(e.target.value) : null
              const known = typed && slashCommands(conversation!).find((c) => c.name === typed[1] || c.app === typed[1])
              if (known) return pickCommand(known, typed![2])
              setText(e.target.value)
              sessionStorage.setItem(draftKey, e.target.value)
              findMention(e.target.value, e.target.selectionStart)
            }}
            onBlur={() => setTimeout(() => setMention(null), 150)}
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData.files)
              if (imgs.length) {
                e.preventDefault()
                void addFiles(imgs)
              }
            }}
            onKeyDown={(e) => {
              if (slashOpen && !e.nativeEvent.isComposing) {
                if (e.key === 'Escape') return (e.preventDefault(), setSlashClosed(true))
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  const n = commands.length
                  return setSlashAt((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  return pickCommand(commands[Math.min(slashAt, commands.length - 1)])
                }
              }
              if (mention && !e.nativeEvent.isComposing) {
                if (e.key === 'Escape') return (e.preventDefault(), setMention(null))
                if (mentionable.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault()
                  const n = mentionable.length
                  return setMentionAt((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
                }
                if (mentionable.length && (e.key === 'Enter' || e.key === 'Tab')) {
                  e.preventDefault()
                  return pickMention(mentionable[Math.min(mentionAt, mentionable.length - 1)])
                }
              }
              // Backspace at the very start drops the picked command.
              if (e.key === 'Backspace' && picked && ta.current?.selectionStart === 0 && ta.current.selectionEnd === 0) {
                e.preventDefault()
                return setPicked(null)
              }
              // Backspace at the very start drops the thread the message was going to.
              if (e.key === 'Backspace' && target && ta.current?.selectionStart === 0 && ta.current.selectionEnd === 0) {
                e.preventDefault()
                return setTarget(null)
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </div>
        <div className="composer-row">
          {attachButton}
          {folderChip}
          {leading}
          <span className="spacer" />
          {modelButton}
          {sendButton}
        </div>
      </div>
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

interface SlashCommand {
  key: string
  name: string
  hint?: string
  /** The app's own command (handled by the app, not sent to the agent). */
  app?: 'subchat' | 'thread'
}

/** The / commands of a conversation: the app's own first, then the agent's. */
function slashCommands(conv: Conversation): SlashCommand[] {
  const list: SlashCommand[] = []
  if (conv.kind === 'chat' && !conv.parentId && !conv.routineId) list.push({ key: 'app:subchat', name: lang === 'en' ? 'subchat' : '子对话', hint: t('交给一个新的子对话去做'), app: 'subchat' }) // i18n-ignore
  if (conv.kind === 'project') list.push({ key: 'app:thread', name: lang === 'en' ? 'thread' : '讨论串', hint: t('开一个讨论串去做'), app: 'thread' }) // i18n-ignore
  for (const c of conv.agentCommands ?? []) list.push({ key: 'agent:' + c.name, name: c.name, hint: c.description?.split('\n')[0] })
  return list
}

/** Agent commands that show or change settings, and ones that act on the session; the rest are prompts or skills. */
const SETTING_COMMANDS = /^(model|models|config|settings|context|usage|cost|mcp|memory|memories|permissions?|status|session-info|always-approve|mode|effort|theme|login|logout|account)$/i
const ACTION_COMMANDS = /^(clear|compact|compress|flush|init|review|feedback|resume|export|reset|new|undo|rewind|dream|quit|exit|help|doctor|bug)$/i

/** An icon that says what kind of command it is, as in Claude's / menu. */
function CommandIcon({ c }: { c: SlashCommand }) {
  const Icon = c.app === 'thread' ? MessagesSquare : c.app === 'subchat' ? GitBranch : SETTING_COMMANDS.test(c.name) ? Settings2 : ACTION_COMMANDS.test(c.name) ? SquareTerminal : ScrollText
  return <Icon size={15} className="slash-icon" />
}

/** Commands for what was typed after /: names that start with it first, then names and descriptions that contain it. */
function matchCommands(all: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return all
  const rank = (c: SlashCommand) => (c.name.toLowerCase().startsWith(q) ? 0 : c.name.toLowerCase().includes(q) ? 1 : c.hint?.toLowerCase().includes(q) ? 2 : 3)
  return all.map((c) => [c, rank(c)] as const).filter(([, r]) => r < 3).sort((a, b) => a[1] - b[1]).map(([c]) => c)
}

/** "/子对话 …" or "/讨论串 …" (or their English names): the app's command and the text after it. */
function appCommand(text: string, conv: Conversation): { command: 'subchat' | 'thread'; text: string } | undefined {
  for (const c of slashCommands(conv)) {
    if (!c.app) continue
    const m = new RegExp(`^/(${escapeRe(c.name)}|${c.app})(?:\\s+([\\s\\S]*))?$`, 'i').exec(text)
    if (m) return { command: c.app, text: (m[2] ?? '').trim() }
  }
  return undefined
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
  const [menu, openMenu] = useMenu({ placement: 'auto' })
  const recent = useApp((s) => {
    const seen = new Set<string>()
    for (const f of s.settings.recentFolders ?? []) seen.add(f)
    for (const c of [...s.conversations].sort((a, b) => b.updatedAt - a.updatedAt)) if (c.cwd) seen.add(c.cwd)
    for (const p of s.projects) if (p.cwd) seen.add(p.cwd)
    return [...seen].slice(0, 6).join('\n')
  })
  const choose = async () => {
    const dir = await api().pickFolder(folder || undefined)
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
