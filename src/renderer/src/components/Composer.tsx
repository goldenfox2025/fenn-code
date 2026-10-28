import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { errorText } from '@shared/errors'
import { ArrowLeftRight, ArrowUp, ChevronDown, CornerDownRight, FileText, Folder, FolderGit2, FolderOpen, GitBranch, MessagesSquare, Pencil, Plus, ScrollText, SendHorizontal, Settings2, Square, SquareTerminal, Trash2, X } from 'lucide-react'
import { MODEL_PROBE_TIMEOUT_MS, type Attachment, type Conversation, type ConversationReference, type FolderCandidate, type Project, type QueuedMessage } from '@shared/model'
import type { SessionOption } from '@shared/contract'
import { api, refreshAccount, toast, useApp, toastError } from '../store'
import { useMenu, type MenuItem } from './Menu'
import { openInFileManager } from '../actions'
import { imeComposing } from '../util'
import { lang, t } from '../i18n'
import { tk } from '@shared/i18n'
const tr = t
const NEED_TEXT = tk('请在命令后面写上要做的事')
const NO_COMMAND = tk('{0} 的命令里没有 /{1}。要照原样发出去，再按一次 Enter。')
const NEED_NAME = tk('请在 /rename 后面写上新名字')
const RENAME_FIRST = tk('还没有对话可以重命名：先发一条消息开始对话，再用 /rename。')
import { choiceLabel, effortStops, optionLabel } from './sessionOptionLabels'
import { perChatOption, sessionOptionDefaults, visibleSessionOptions } from '@shared/sessionOptions'
import { backendAvailable } from '@shared/backendAvailability'
import { EffortPicker } from './EffortPicker'
import { ContextRing } from './Usage'
import { BackendLogo } from './BackendLogo'
import { FoxMark } from './FoxMark'
import { useComposerFit } from './useComposerFit'

interface Props {
  conversation?: Conversation
  placeholder?: string
  autoFocus?: boolean
  /** For a not-yet-created chat: called with the text instead of sending. */
  onSubmit?: (text: string, attachments: Attachment[], optionValues?: Record<string, string>) => Promise<unknown>
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
  const suggestionId = useId()
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
  const [menu, openMenu, updateMenu, closeMenu] = useMenu({ placement: 'auto', align: 'right', compact: true })
  const fit = useComposerFit()
  useLayoutEffect(() => { closeMenu() }, [fit.compact])
  const hasPermission = useApp((s) => !!conversation && s.permissions.some((p) => p.conversationId === conversation.id))
  const busy = conversation?.status === 'working' || hasPermission
  const draftKey = conversation ? `draft:${conversation.id}` : 'draft:new'
  const draftKeyNow = useRef(draftKey)
  draftKeyNow.current = draftKey
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // A new chat being started: the send button waits, so a second press doesn't start another.
  const [starting, setStarting] = useState(false)

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

  /** The text last held back as a command the agent doesn't list: sent as is if submitted again. */
  const warned = useRef<string | undefined>(undefined)
  const submit = async () => {
    // A model or option still switching: the message goes once it has, with the new choice.
    if (selection.current) await selection.current
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
    const app = conversation && !references.length && appCommand(t, conversation)
    if (app) {
      if (!app.text) return toast(tr(NEED_TEXT), 'error')
      setText('')
      sessionStorage.removeItem(draftKey)
      void api().runCommand(conversation.id, app.command, app.text).catch(toastError)
      return
    }
    // A new chat has nothing to rename yet, and the agent shouldn't get the command as its first message.
    if (!conversation && /^\/rename(\s|$)/i.test(t)) return toast(tr(RENAME_FIRST), 'error')
    // Renaming is the app's to do when the agent has no /rename of its own (or hasn't said yet).
    if (conversation && !references.length && !files.length && /^\/rename(\s|$)/i.test(t) && !slashCommands(conversation).some((c) => c.name.toLowerCase() === 'rename')) {
      const name = t.slice(7).trim()
      if (!name) return toast(tr(NEED_NAME), 'error')
      setText('')
      sessionStorage.removeItem(draftKey)
      void api().updateConversation(conversation.id, { title: name.slice(0, 120) }).catch(toastError)
      return
    }
    // A / command the agent doesn't list would reach it as an ordinary message (「/compact」 to an agent
    // without one): say so first. Enter again sends it as written (a path, or a command it accepts unlisted).
    const unknown = conversation && !references.length && !files.length ? missingCommand(t, conversation) : undefined
    if (unknown && warned.current !== t) {
      warned.current = t
      return toast(tr(NO_COMMAND, currentBackend?.name ?? conversation!.backendId, unknown), 'error')
    }
    warned.current = undefined
    // A new chat keeps its text in the box until it has started: nothing typed is lost if it can't.
    if (onSubmit) {
      if (starting) return
      setStarting(true)
      try {
        await onSubmit(t, files, Object.keys(pending).length ? pending : undefined)
        sessionStorage.removeItem(draftKey)
        if (mounted.current) {
          setText('')
          setFiles([])
        }
      } catch (e) {
        toastError(e)
      } finally {
        if (mounted.current) setStarting(false)
      }
      return
    }
    const sentText = text
    const sentFiles = files
    const sentReferences = references
    const key = draftKey
    setText('')
    setFiles([])
    saveReferences([])
    sessionStorage.removeItem(key)
    // A message that didn't go comes back into the box (unless something new was typed there meanwhile).
    const putBack = (e: unknown) => {
      toastError(e)
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, sentText)
      if (sentReferences.length) sessionStorage.setItem(`${key}:references`, JSON.stringify(sentReferences))
      if (!mounted.current || draftKeyNow.current !== key) return
      setText((cur) => cur || sentText)
      setFiles((cur) => (cur.length ? cur : sentFiles))
      saveReferences(sentReferences)
    }
    if (conversation) void api().send(conversation.id, t, files, sentReferences.map((reference) => reference.id)).catch(putBack)
  }

  // References add context to this conversation. Only an explicit agent action dispatches work.
  const [references, setReferences] = useState<ConversationReference[]>([])
  const saveReferences = (next: ConversationReference[]) => {
    const unique = next.filter((reference, index) => next.findIndex((other) => other.id === reference.id) === index).slice(0, 8)
    setReferences(unique)
    if (unique.length) sessionStorage.setItem(`${draftKey}:references`, JSON.stringify(unique))
    else sessionStorage.removeItem(`${draftKey}:references`)
  }
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const [mentionAt, setMentionAt] = useState(0)
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`${draftKey}:references`) ?? '[]')
      setReferences(Array.isArray(saved) ? saved.filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string').slice(0, 8) : [])
    }
    catch { setReferences([]) }
  }, [draftKey])
  // Only while @ is being typed in a project chat: the list doesn't redraw the composer otherwise.
  const allThreads = useApp((s) => (mention && conversation?.projectId ? s.conversations : NO_CONVERSATIONS))
  const mentionable =
    conversation?.projectId && mention
      ? allThreads
          .filter((c) => c.id !== conversation.id && c.projectId === conversation.projectId && !references.some((reference) => reference.id === c.id) && c.title.toLowerCase().includes(mention.query.toLowerCase()))
          .sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved) || b.updatedAt - a.updatedAt)
          .slice(0, 8)
      : []
  const findMention = (value: string, caret: number) => {
    if (!conversation?.projectId) return setMention(null)
    const m = /(^|[\s\p{Script=Han}\p{P}])@([^\s@]{0,24})$/u.exec(value.slice(0, caret))
    setMention(m ? { query: m[2], start: caret - m[2].length - 1, end: caret } : null)
    setMentionAt(0)
  }
  const pickMention = (th: { id: string; title: string }) => {
    if (!mention) return
    const next = text.slice(0, mention.start) + text.slice(mention.end)
    setText(next)
    sessionStorage.setItem(draftKey, next)
    saveReferences([...references, { id: th.id, title: th.title }])
    setMention(null)
    // The caret goes where the @ was in the same render as the text, as for a picked command:
    // set a frame later it would jump back over whatever was typed meanwhile.
    caretTo.current = mention.start
  }

  // / opens the commands: the app's own (a sub-conversation, a thread) and the agent's.
  // A picked command sits in the box as a chip; the text after it is its argument.
  const [picked, setPicked] = useState<SlashCommand | null>(null)
  useEffect(() => setPicked(null), [conversation?.id])
  const slashQuery = conversation && !references.length && !picked ? /^\/(\S*)$/.exec(text)?.[1] : undefined
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
  // A model just picked shows at once, while the agent switches to it.
  const [shownModel, setShownModel] = useState<string>()
  const actualModel = conversation ? session?.modelId : modelId
  useEffect(() => setShownModel(undefined), [conversation?.id, bid])
  useEffect(() => {
    if (shownModel && actualModel === shownModel) setShownModel(undefined)
  }, [shownModel, actualModel])
  const wanted = shownModel ?? actualModel ?? savedModel ?? remembered?.current
  const currentModel = models.find((m) => m.id === wanted) ?? models.find((m) => m.id === remembered?.current) ?? models[0]
  // The session's other choices (mode, thinking level); before a session, the backend's last list and the defaults.
  const defaults = sessionOptionDefaults(settings, bid, currentModel?.id)
  const options = visibleSessionOptions(session?.sessionOptions ?? remembered?.options ?? [], currentBackend?.optionPolicy)
  // A mode or role picked before the first message belongs to that chat only, not to every later one.
  const [pending, setPending] = useState<Record<string, string>>({})
  useEffect(() => setPending({}), [bid, conversation?.id])
  const valueOf = (o: SessionOption) => {
    const v = session?.sessionOptions !== undefined ? o.current : (session?.optionValues?.[o.id] ?? pending[o.id] ?? (perChatOption(o) ? undefined : defaults[o.id]) ?? o.current)
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
    // The account check knows best: a probe that failed earlier says nothing once it says signed in.
    accountState(id) ?? (accounts[id]?.signedIn !== true && id === catalogFor.current.id && catalogFor.current.needsLogin ? t('未登录') : undefined)

  // Connect to the agent while the user reads or types, so pressing Enter only sends (no prompt is sent here).
  const ready = !!conversation && !!currentBackend && !accountHint(bid)
  useEffect(() => {
    if (ready && conversation && !busy) void api().prepareConversation(conversation.id).catch(() => undefined)
  }, [conversation?.id, bid, ready])

  // A chat with this agent is open: start it now, so the first message doesn't wait for it to start.
  const warmable = !!currentBackend && !accountHint(bid)
  const newChatFolder = conversation ? undefined : (folder ?? '')
  useEffect(() => {
    if (warmable) void api().warmBackend(bid, newChatFolder).catch(() => undefined)
  }, [bid, warmable, newChatFolder])

  // The models a backend offers, read from a fresh session before the first message (no prompt is sent).
  const [catalog, setCatalog] = useState<{ for: string; loading: boolean; error?: string; needsLogin?: boolean; stillStarting?: boolean }>({ for: '', loading: false })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let live = true
    const known = models.length > 0 && (!wanted || remembered?.current === wanted || !!conversation?.sessionRef)
    if (!bid || busy || accountState(bid) || known) return setCatalog({ for: bid, loading: false })
    setCatalog({ for: bid, loading: true })
    const started = Date.now()
    api()
      .backendModels(bid, wanted)
      .then(
        (c) => live && setCatalog({ for: bid, loading: false, needsLogin: c.needsLogin }),
        (e) => live && setCatalog({ for: bid, loading: false, error: errorText(e), stillStarting: Date.now() - started >= MODEL_PROBE_TIMEOUT_MS - 1000 })
      )
    return () => {
      live = false
    }
  }, [bid, wanted, conversation?.id, conversation?.sessionRef?.sessionId, busy, currentBackend?.installed, accounts[bid]?.signedIn, retry])
  const loadingModels = catalog.loading || catalog.for !== bid
  // Some agents take a while to start (Antigravity: 15–25 s on Windows): after a few seconds, say so.
  const [slowStart, setSlowStart] = useState(false)
  useEffect(() => {
    setSlowStart(false)
    if (!loadingModels) return
    const timer = setTimeout(() => setSlowStart(true), 4000)
    return () => clearTimeout(timer)
  }, [loadingModels, bid])
  catalogFor.current = { id: catalog.for, needsLogin: catalog.needsLogin }

  // One choice at a time; the message waits until it has been applied.
  const [selecting, setSelecting] = useState(false)
  // A picked app command (/子对话) needs words after it; an agent command (/compact) goes as it is.
  const canSend = !starting && (!!text.trim() || files.length > 0 || (!!picked && !picked.app))
  // Choices run one at a time; a click while one is still switching is kept, and the latest one wins.
  const selection = useRef<Promise<void> | null>(null)
  const nextChoice = useRef<(() => Promise<unknown>) | null>(null)
  const choose = (op: () => Promise<unknown>) => {
    if (selection.current) {
      nextChoice.current = op
      return
    }
    setSelecting(true)
    selection.current = (async () => {
      for (let run: (() => Promise<unknown>) | null = op; run; ) {
        try {
          await run()
        } catch (e) {
          setShownModel(undefined)
          toastError(e)
        }
        run = nextChoice.current
        nextChoice.current = null
      }
    })().finally(() => {
      selection.current = null
      setSelecting(false)
    })
  }

  const setOptionValue = (o: SessionOption, value: string) => {
    if (!conversation && perChatOption(o)) return setPending((p) => ({ ...p, [o.id]: value }))
    // A thinking level carries over to new chats (the app remembers it); a mode or role stays with this conversation.
    choose(() => (session ? api().setOption(session.id, o.id, value) : api().setOptionDefault(bid, o.id, value)))
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
      if (conversation) choose(() => api().updateConversation(conversation.id, { backendId: id }))
      else onBackendChange?.(id)
    }
    const [top, rest] = firstFew(usable, (b) => b.id === bid)
    // Mid-reply the reply keeps going; the picked agent takes over with the next message.
    const cuts = (id: string) => (busy && conversation && id !== conversation.backendId && id !== bid ? t('下一条消息起换成这个') : undefined)
    const items: MenuItem[] = top.map((b, i) => ({ label: b.name, icon: <BackendLogo id={b.id} size={18} />, sub: cuts(b.id), checked: b.id === bid, shortcut: String(i + 1), onClick: () => pick(b.id) }))
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
      if (loadingModels)
        items.push(slowStart ? { label: t('正在启动 {0}…', currentBackend?.name ?? bid), sub: t('第一次可能要半分钟'), info: true, busy: true } : { label: t('正在加载模型…'), info: true, busy: true })
      else if (catalog.error)
        items.push({ label: catalog.stillStarting ? t('{0} 还在启动', currentBackend?.name ?? bid) : t('无法加载模型列表'), hint: t('重试'), onClick: () => setRetry((n) => n + 1) })
    }
    const setModel = (id: string) => {
      setShownModel(id)
      choose(async () => {
        if (session) return api().setModel(session.id, id)
        await api().setModelDefault(bid, id)
        onModelChange?.(id)
      })
    }
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
  // Compact and full controls share the exact same choices and mutation paths.
  const settingsItems = (): MenuItem[] => [
    ...(canSwitch ? [{ label: t('后端'), hint: currentBackend?.name, submenu: backendItems() }] : []),
    ...(canPick ? [{ label: t('模型'), hint: currentModel?.name, submenu: modelItems() }] : []),
    ...(effortOpt && canPick && !signedOut ? [{ label: optionLabel(effortOpt), hint: choiceLabel(effortOpt.choices.find((c) => c.value === valueOf(effortOpt))?.name ?? '', valueOf(effortOpt), effortOpt.category), submenu: effortStops(effortOpt.choices).map((c) => ({ label: choiceLabel(c.name, c.value, effortOpt.category), checked: c.value === valueOf(effortOpt), onClick: () => setOptionValue(effortOpt, c.value) })) }] : [])
  ]
  const menuFor = useRef<'model' | 'backend' | 'settings'>('model')
  const itemsFor = (which: typeof menuFor.current) => which === 'settings' ? settingsItems() : which === 'model' ? modelItems() : backendItems()
  const optionSignature = options.map((o) => `${o.id}:${valueOf(o)}:${o.choices.map((c) => c.value).join(',')}`).join('|')
  const modelSignature = models.map((m) => `${m.id}:${m.name}`).join('|')
  // An open menu shows newly arrived models and the current selection.
  useEffect(() => updateMenu(itemsFor(menuFor.current)), [modelSignature, loadingModels, slowStart, catalog.error, catalog.needsLogin, bid, currentModel?.id, optionSignature, accounts, busy])
  const open = (which: typeof menuFor.current, el: HTMLElement) => {
    menuFor.current = which
    openMenu(el, itemsFor(which))
  }

  const showModel = canPick && (models.length > 0 || loadingModels || !!catalog.error || signedOut)
  const modelButton = (
    <span className={'model-group' + (fit.compact ? ' compact' : '')}>
      <span ref={fit.controls} className="model-controls" aria-hidden={fit.compact || undefined} inert={fit.compact}>
      {canSwitch && (
        <button className="footer-chip backend-chip" aria-haspopup="menu" data-tip={staged ? t('下一条消息起换成 {0}', currentBackend?.name ?? '') : t('后端')} onClick={(e) => (e.stopPropagation(), open('backend', e.currentTarget))}>
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
        <EffortPicker option={effortOpt} value={valueOf(effortOpt)} suspended={fit.compact} onChange={(v) => setOptionValue(effortOpt, v)} />
      )}
      </span>
      {fit.compact && (canSwitch || canPick) && <button className="icon-btn model-settings" aria-label={t('模型与后端设置')} aria-haspopup="menu" data-tip={[currentBackend?.name, currentModel?.name].filter(Boolean).join(' · ')} onClick={(e) => (e.stopPropagation(), open('settings', e.currentTarget))}><Settings2 size={16} /></button>}
      {conversation ? (
        <ContextRing
          key={conversation.id}
          usage={conversation.usage}
          timing={conversation.timing}
          scope={conversation.kind === 'thread' ? t('本讨论串用量') : t('本对话用量')}
          onCompact={conversation.compactCommand && !busy ? () => void api().compactContext(conversation.id).catch(toastError) : undefined}
        />
      ) : null}
    </span>
  )
  // An isolated project worker has its own checkout; its folder picker must never change the project.
  const project = useApp((s) => s.projects.find((p) => p.id === conversation?.projectId))
  const isolated = !!conversation?.isolateWorkspace
  const ownsFolder = conversation && conversation.kind !== 'chat' && !isolated && project
  const folderNow = conversation ? (ownsFolder ? project.cwd : conversation.cwd) || '' : (folder ?? '')
  const setFolder = (f: string) => {
    if (!conversation) return onFolderChange?.(f)
    const failed = toastError
    if (ownsFolder) void api().updateProject(project.id, { cwd: f }).catch(failed)
    else void api().updateConversation(conversation.id, { cwd: f }).catch(failed)
  }
  const canSetFolder = !!(conversation || onFolderChange) && !isolated
  const folderChip = (canSetFolder || isolated) && <FolderChip folder={folderNow} onChange={setFolder} readOnly={isolated} project={project} hint={project?.name || conversation?.title || text} />
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
  // Messages handed back (by 停止 or 编辑) go into the composer ahead of what's being typed.
  const restore = (back: QueuedMessage[]) => {
    if (!back.length) return
    setText((cur) => {
      const restored = [...back.map((q) => q.text), cur].filter((x) => x.trim()).join('\n\n')
      sessionStorage.setItem(draftKey, restored)
      return restored
    })
    const files = back.flatMap((q) => q.attachments ?? [])
    if (files.length) setFiles((cur) => [...files, ...cur])
    saveReferences([...back.flatMap((message) => message.references ?? []), ...references])
    ta.current?.focus()
  }
  // Stopping hands back what was still waiting, so nothing the user typed is lost.
  const stop = async () => {
    if (!conversation) return
    restore(await api().cancel(conversation.id).catch((e) => (toastError(e), [])))
  }
  /** A waiting message: send it now (stopping the reply, after any model switch in progress), edit it, or drop it. */
  const queued = async (id: string, action: 'now' | 'edit' | 'delete') => {
    if (!conversation) return
    try {
      if (action === 'now') {
        if (selection.current) await selection.current
        await api().queuedMessage(conversation.id, id, 'now')
        return
      }
      const q = await api().queuedMessage(conversation.id, id, 'take')
      if (q && action === 'edit') restore([q])
    } catch (e) {
      toastError(e)
    }
  }
  const attachButton = (
    <button className="icon-btn" data-tip={t('添加文件或图片')} onClick={(e) => (e.stopPropagation(), picker.current?.click())}>
      <Plus size={18} />
    </button>
  )
  // Two buttons, not one that changes: each keeps its own name for screen readers.
  const sendButton =
    busy && !canSend ? (
      <button key="stop" className="send-btn stop" aria-label={t('停止')} data-tip={t('停止')} onClick={stop}>
        <Square size={12} fill="currentColor" />
      </button>
    ) : (
      <button key="send" className="send-btn" aria-label={t('发送')} disabled={!canSend} onClick={submit} data-tip={t('发送 (Enter)')}>
        <ArrowUp size={18} />
      </button>
    )

  return (
    <div className="composer-wrap">
      {busy && conversation && <HousekeepingTimer conversationId={conversation.id} />}
      {!!conversation?.queued?.length && (
        <div className="queue-tray" aria-label={t('等待发送')}>
          {conversation.queued.map((q) => (
            <div key={q.id} className="queue-row">
              <CornerDownRight size={14} />
              <span className="queue-text">{q.text || t('{0} 个附件', q.attachments?.length ?? 0)}</span>
              <button className="icon-btn sm" data-tip={t('立即发送')} aria-label={t('立即发送')} onClick={() => void queued(q.id, 'now')}>
                <SendHorizontal size={14} />
              </button>
              <button className="icon-btn sm" data-tip={t('编辑')} onClick={() => void queued(q.id, 'edit')}>
                <Pencil size={14} />
              </button>
              <button className="icon-btn sm" data-tip={t('删除')} onClick={() => void queued(q.id, 'delete')}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
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
          <div id={`${suggestionId}-slash`} className="slash-pop" role="listbox" aria-label={t('命令')}>
            {commands.map((c, i) => (
              <Fragment key={c.key}>
                {(i === 0 || !!commands[i - 1].app !== !!c.app) && (
                  <div className="slash-group">{c.app ? 'Fenn Code' : (currentBackend?.name ?? 'Agent')}</div>
                )}
                <button
                  role="option"
                  id={`${suggestionId}-slash-${i}`}
                  tabIndex={-1}
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
        {mention && conversation?.projectId && (
          <div id={`${suggestionId}-mention`} className="menu compact mention-menu" role="listbox" aria-label={t('引用对话')}>
            {mentionable.length ? (
              mentionable.map((th, i) => (
                <button
                  key={th.id}
                  role="option"
                  id={`${suggestionId}-mention-${i}`}
                  tabIndex={-1}
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
          {references.map((reference) => (
            <span className="mention-chip" key={reference.id}>
              <MessagesSquare size={13} />
              <span className="reference-name">@{reference.title}</span>
              <button className="icon-btn xs" aria-label={t('移除引用')} onClick={() => saveReferences(references.filter((other) => other.id !== reference.id))}>
                <X size={12} />
              </button>
            </span>
          ))}
          <textarea
            ref={ta}
            role="combobox"
            aria-label={t('消息')}
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={slashOpen || !!mention}
            aria-controls={slashOpen ? `${suggestionId}-slash` : mention ? `${suggestionId}-mention` : undefined}
            aria-activedescendant={slashOpen ? `${suggestionId}-slash-${Math.min(slashAt, commands.length - 1)}` : mentionable.length ? `${suggestionId}-mention-${Math.min(mentionAt, mentionable.length - 1)}` : undefined}
            rows={1}
            value={text}
            placeholder={picked ? (picked.app === 'subchat' ? t('交给子对话做什么？') : picked.app === 'thread' ? t('让讨论串做什么？') : picked.hint ?? '') : (placeholder ?? (busy ? t('继续输入，消息会在当前回复结束后发送') : t('回复…')))}
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
              if (slashOpen && !imeComposing(e)) {
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
              if (mention && !imeComposing(e)) {
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
              // Backspace removes the last contextual reference, never changes the destination.
              if (e.key === 'Backspace' && references.length && ta.current?.selectionStart === 0 && ta.current.selectionEnd === 0) {
                e.preventDefault()
                return saveReferences(references.slice(0, -1))
              }
              if (e.key === 'Enter' && !e.shiftKey && !imeComposing(e)) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </div>
        <div className="composer-row" ref={fit.row}>
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

/**
 * The name of a / command the conversation's agent doesn't offer, or undefined. Only once the agent
 * has a session (its commands arrive with it) and only for a command-like word, so a path such as
 * /home/x or a lone / still goes as text.
 */
function missingCommand(text: string, conv: Conversation): string | undefined {
  const name = /^\/([A-Za-z][\w-]*)(?:\s|$)/.exec(text)?.[1]
  if (!name || (!conv.agentCommands && !conv.sessionRef)) return undefined
  if (slashCommands(conv).some((c) => c.name.toLowerCase() === name.toLowerCase())) return undefined
  return name
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
      <FoxMark thinking />
      <span className="shimmer">{t('正在整理项目记忆')}</span> {s < 60 ? t('{0} 秒', s) : t('{0} 分 {1} 秒', Math.floor(s / 60), s % 60)}
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
        <button className="icon-btn sm" aria-label={t('移除')} onClick={(e) => (e.stopPropagation(), onRemove())}>
          <X size={12} />
        </button>
      )}
    </div>
  )
}

async function readAttachment(f: File): Promise<Attachment> {
  // The file's real place on disk (from the preload); a pasted image has none.
  const path = (window as unknown as { fennFilePath?: (f: File) => string }).fennFilePath?.(f) || undefined
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
export function FolderChip({ folder, onChange, hint = '', readOnly = false, project }: { folder: string; onChange: (folder: string) => void; hint?: string; readOnly?: boolean; project?: Pick<Project, 'name' | 'cwd'> }) {
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
        data-tip={project ? project.name : folder ? t('工作文件夹：{0}', folder) : t('选择工作文件夹，让 agent 能读写其中的文件、运行命令')}
        onClick={async (e) => {
          e.stopPropagation()
          const el = e.currentTarget
          if (project) return openMenu(el, [
            { icon: <Folder size={15} />, label: project.name, sub: project.cwd, info: true },
            ...(project.cwd ? [{ icon: <FolderOpen size={15} />, label: t('打开项目文件夹'), onClick: () => void openInFileManager(project.cwd!) }] : []),
            ...(readOnly && folder && folder !== project.cwd ? [{ label: t('独立工作区'), submenu: [
              { label: t('此工作区属于当前讨论串'), sub: folder, info: true },
              { icon: <FolderOpen size={15} />, label: t('在文件管理器中打开'), onClick: () => void openInFileManager(folder) }
            ] }] : []),
            ...(!readOnly ? [{ separator: true }, { icon: <ArrowLeftRight size={15} />, label: t('换一个文件夹…'), onClick: () => void choose() }] : [])
          ])
          const others = recent.split('\n').filter((f) => f && f !== folder)
          const recentItems = (list: string[]): MenuItem[] => list.length
            ? [{ heading: t('最近使用') }, ...list.map((f) => ({ icon: <Folder size={15} />, label: baseName(f), sub: f, onClick: () => onChange(f) }))]
            : []
          // A folder is chosen: the menu is about that folder, not suggestions for another.
          if (folder)
            return openMenu(el, [
              { icon: <Folder size={15} />, label: baseName(folder), sub: folder, info: true },
              { icon: <FolderOpen size={15} />, label: t('在文件管理器中打开'), onClick: () => void openInFileManager(folder) },
              ...(!readOnly ? [
              { icon: <ArrowLeftRight size={15} />, label: t('换一个文件夹…'), onClick: () => void choose() },
              ...(others.length ? [{ separator: true } as MenuItem, ...recentItems(others.slice(0, 3))] : []),
              { separator: true } as MenuItem,
              { icon: <X size={15} />, label: t('不使用文件夹'), onClick: () => onChange('') }
              ] : [])
            ])
          // Likely project folders, found by a quick scan the app caches; the menu doesn't wait long for it.
          const found = await Promise.race([
            api().suggestFolders(hint).catch(() => [] as FolderCandidate[]),
            new Promise<FolderCandidate[]>((r) => setTimeout(() => r([]), 1200))
          ])
          const likely = found.filter((f) => !others.includes(f.path)).slice(0, 5)
          openMenu(el, [
            { icon: <FolderOpen size={15} />, label: t('选择文件夹…'), onClick: () => void choose() },
            ...recentItems(others),
            ...(likely.length ? [{ heading: t('可能的项目文件夹') } as MenuItem] : []),
            ...likely.map((f) => ({ icon: <FolderGit2 size={15} />, label: f.name, sub: f.path, onClick: () => onChange(f.path) }))
          ])
        }}
      >
        <Folder size={15} />
        <span className="dropdown-value">{project?.name || (folder ? baseName(folder) : t('文件夹'))}</span>
      </button>
      {menu}
    </>
  )
}
