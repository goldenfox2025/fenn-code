/**
 * The application service behind window.fenn. Electron-free so it can
 * be driven from tests; main/index.ts only wires it to IPC.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setAcpDebugLog } from '../backends/acp/debugLog'
import { homedir } from 'node:os'
import { boardWidgetKey, type AppEvent, type AppSettings, type AppSnapshot, type Attachment, type BoardWidget, type Conversation, Message, NewChatOptions, Project, Routine, Schedule, SearchHit, Connector, ConnectorView, AppInfo, UpdateCheck, ProgressItem, ProgressPatch, FolderCandidate, UsageSummary } from '../../shared/model'
import { removeTurn } from '../../shared/usage'
import { UsageCalendar } from './UsageCalendar'
import type { BackendManager } from '../backends/BackendManager'
import type { Store } from '../store/Store'
import type { ToolServer } from '../tools/ToolServer'
import type { AccountStatus, BackendPlugin, BackendSummary, HostToolServer } from '../../shared/contract'
import { prestartOn } from '../../shared/backendAvailability'
import { ProjectFiles } from './ProjectFiles'
import { addFile, changedFiles, createEntry, inside, listFolder, readPreview, removablePath, renameEntry, writeText, type LibraryRefusal } from './Library'
import { Artifacts } from './Artifacts'
import { ComputerControl, type ComputerDeps, type TierChoice } from '../computer/ComputerControl'
import { ChatService, excerpt, textOf } from './ChatService'
import { AutoAssigner } from './AutoAssigner'
import { folderSafeName, moveContents, uniqueDir } from './autoFolder'
import { isUnsafeFolder } from '../../shared/unsafeFolders'
import { PeerMail } from './PeerMail'
import { Orchestrator } from './Orchestrator'
import { ProjectMemory } from './ProjectMemory'
import { Scheduler } from './Scheduler'
import { BACKENDS_EXAMPLE, PREFERRED_BACKENDS } from '../backends/registry'
import { titleFrom } from './titles'
import { routineTools } from './tools/routineTools'
import { boardTools } from './tools/boardTools'
import { applyPatch, removeItem } from './progress'
import { FolderFinder, foldersInText, matchingFolders, rankFolders } from './folders'
import { getLang, localeTag, t } from '../../shared/i18n'
import { MODEL_PROBE_TIMEOUT_MS, type BackendModelCatalog } from '../../shared/model'
import { classifyError } from '../../shared/errors'

/** An unanswered request to control the computer gives up after this long. */
const ASK_TIMEOUT_MS = 3 * 60_000
// A model picked before a chat starts: its own choices are read once the user has stopped picking for this long.
const PROBE_SETTLE_MS = 1500

export class AppCore {
  readonly chat: ChatService
  readonly orchestrator: Orchestrator
  readonly autoAssigner: AutoAssigner
  readonly scheduler: Scheduler
  readonly peers: PeerMail
  readonly memory: ProjectMemory
  private readonly calendar: UsageCalendar
  readonly files: ProjectFiles
  readonly artifacts: Artifacts
  computer?: ComputerControl
  private readonly secrets: { seal(v: string): string; unseal(v: string): string }

  constructor(
    readonly store: Store,
    readonly backends: BackendManager,
    readonly publish: (e: AppEvent) => void,
    readonly platform: string,
    readonly tools: ToolServer,
    extras: {
      computer?: Pick<ComputerDeps, 'screen' | 'input' | 'clipboard' | 'pasteChord' | 'onActive' | 'onAction' | 'isOwnApp'>
      /** Encrypts connector secrets at rest (the OS keychain in the app). */
      secrets?: { seal(v: string): string; unseal(v: string): string }
      /** backends.json couldn't be read at startup (see backendsConfigError). */
      backendsConfigError?: string
    } = {}
  ) {
    this.secrets = extras.secrets ?? { seal: (v) => v, unseal: (v) => v }
    this.backendsConfigError = extras.backendsConfigError
    this.chat = new ChatService(store, backends, publish)
    if (store.settings.acpDebugLog) setAcpDebugLog(this.logDir)
    this.memory = new ProjectMemory(store.dir)
    this.calendar = new UsageCalendar(store)
    this.chat.turnEndListeners.add((id) => this.calendar.add(store.messagesOf(id).findLast((m) => m.role === 'assistant')))
    // Replies gone (a deleted chat, a regenerated reply) are counted afresh.
    this.chat.rewrittenListeners.add(() => this.calendar.reset())
    this.memory.onChange = (projectId) => this.publish({ type: 'memory-changed', projectId })
    this.files = new ProjectFiles(store.dir)
    this.artifacts = new Artifacts(store.dir)
    this.orchestrator = new Orchestrator(store, this.chat, tools, this.memory, this.files, this.artifacts, backends)
    this.peers = new PeerMail(store, this.chat, publish)
    this.orchestrator.peers = this.peers
    this.orchestrator.progress = (projectId, patch, by) => this.applyProgress(projectId, patch, by)
    this.orchestrator.onProjectChanged = (project) => this.publish({ type: 'project', project })
    this.orchestrator.pickBackend = (preferred) => this.resolveBackend(preferred)
    this.orchestrator.extraTools = (conv) => [
      ...routineTools({ store, isUnattended: (id) => this.chat.isUnattended(id), notice: (id, text, key) => this.chat.notice(id, 'info', text, key), save: (r) => this.saveRoutine(r), remove: (id) => this.deleteRoutine(id) }, conv),
      ...boardTools(
        {
          store,
          isUnattended: (id) => this.chat.isUnattended(id),
          notice: (id, text, key) => this.chat.notice(id, 'info', text, key),
          put: (w) => this.putBoardWidget(w),
          remove: (id) => this.deleteBoardWidget(id),
          saveRoutine: (r) => this.saveRoutine(r),
          deleteRoutine: (id) => this.deleteRoutine(id)
        },
        conv
      ),
      ...(this.computer?.tools(conv) ?? [])
    ]
    // What the app keeps per conversation goes with it.
    this.chat.removedListeners.add((id) => {
      this.calendar.reset()
      this.tools.revoke(id)
      this.computer?.forget(id)
      this.peers.removed(id)
      this.switches.delete(id)
      this.movedNotes.delete(id)
    })
    this.autoAssigner = new AutoAssigner(
      store,
      this.chat,
      () => [...new Set([...(store.settings.recentFolders ?? []), ...store.projects.map((p) => p.cwd ?? '')])].filter((f) => f && !this.unsafeFolder(f)),
      (id, folder) => void this.updateConversation(id, { cwd: folder }).catch(() => {}),
      [join(store.dir, 'workspaces')]
    )
    this.scheduler = new Scheduler(store, this)
    this.orchestrator.extraServers = () => this.connectorServers()
    if (extras.computer) {
      const computer = new ComputerControl({
        ...extras.computer,
        enabled: () => !!this.store.settings.computerUse,
        askAccess: async (conversationId, req) => {
          const answer = await this.chat.askUser(
            conversationId,
            {
              title: t('允许 agent 操控这些程序？'),
              detail:
                (req.reason ? t('用途：{0}', req.reason) + '\n' : '') +
                t('agent 会看到整个屏幕的截图，但只能在下面允许的程序里点击和输入。操控期间 Fenn Code 会最小化，屏幕上方有「停止」按钮；闲置 30 分钟后需要重新允许。'),
              apps: req.apps,
              options: [
                { id: 'allow', label: t('允许'), kind: 'allow_always' },
                { id: 'deny', label: t('不允许'), kind: 'reject_once' }
              ]
            },
            ASK_TIMEOUT_MS
          )
          return parseAccessAnswer(answer)
        },
        unattended: (id) => this.chat.isUnattended(id),
      })
      this.computer = computer
      this.chat.turnEndListeners.add((id) => computer.turnEnded(id))
    }
    this.repairBackends()
    this.separateChatsFromProjects()
    this.leaveUnsafeFolders()
    this.endStaleCommands()
    this.dropCopiedUsage()
    this.signInRepair = this.repairSignIns().catch(() => undefined)
    const orchestrate = this.chat.hooks.afterTurn
    this.chat.hooks.afterTurn = (conv, reply, result) => {
      orchestrate?.(conv, reply, result)
      // Titled first, so a folder made for the chat carries its real name.
      void this.autoAssigner.consider(conv, reply).catch(() => {}).then(() => this.placeChat(conv.id, reply.id)).catch(() => {})
    }
    this.chat.hooks.adoptFolder = (id, folder) => this.adoptFolder(id, folder)
    this.chat.hooks.standIn = (conv) => {
      const id = conv.projectId || conv.routineId ? this.standIns.get(conv.backendId) : undefined
      return id && this.backends.has(id) ? id : undefined
    }
    const digest = this.chat.hooks.beforePrompt
    this.chat.hooks.beforePrompt = (conv) => {
      const moved = this.movedNotes.get(conv.id)
      this.movedNotes.delete(conv.id)
      return [moved, digest?.(conv)].filter(Boolean).join('\n\n')
    }
  }

  /** Home, a drive root or Fenn Code's own data: never a working folder (see isUnsafeFolder). */
  unsafeFolder(path: string | undefined): boolean {
    return !!path && isUnsafeFolder(path, homedir(), this.store.dir, process.platform === 'darwin')
  }

  private refuseFolder(path: string | undefined): void {
    if (this.unsafeFolder(path)) throw new Error(t('不能在 {0} 里工作：这里是主目录、磁盘根目录或 Fenn Code 的数据目录。请选一个具体的文件夹。', path!))
  }

  /** Set by the Electron shell: the user's Documents folder. */
  documentsDir = join(homedir(), 'Documents')
  private movedNotes = new Map<string, string>()
  // Chats whose folder the user picked from a permission prompt while the agent worked in its scratch folder.
  private adopted = new Set<string>()

  /** 「设为工作文件夹」 on a permission prompt: the chat works in that folder from now on. */
  private adoptFolder(conversationId: string, folder: string): void {
    const conv = this.store.conversation(conversationId)
    if (!conv || conv.kind !== 'chat' || this.chat.folderOf(conv) || this.unsafeFolder(folder)) return
    this.chat.patchConversation(conversationId, { cwd: folder, autoFolder: undefined })
    this.rememberFolder(folder)
    this.adopted.add(conversationId)
    // The agent started in its scratch folder; the next turn opens a session in the chosen one.
    this.chat.renewSession(conversationId)
  }

  /** Where chats that made files get their own folder (Settings → 通用). */
  autoFolderRoot(): string {
    return this.store.settings.autoFolderRoot || this.defaultFolder()
  }

  /** Documents/Fenn Code, or Documents/Ancora where the app made that before it was renamed (chats point into it). */
  private defaultFolder(): string {
    const legacy = join(this.documentsDir, 'Ancora')
    const current = join(this.documentsDir, 'Fenn Code')
    return !existsSync(current) && existsSync(legacy) ? legacy : current
  }

  /**
   * A chat with no folder works in a private scratch space. Once the agent has
   * made files there, the chat gets a readable folder named after it, under
   * autoFolderRoot(), with those files moved in. A chat that never makes files keeps none.
   */
  async placeChat(conversationId: string, replyId?: string): Promise<string | undefined> {
    const conv = this.store.conversation(conversationId)
    if (!conv || conv.kind !== 'chat' || conv.routineId || this.chat.isBusy(conv.id)) return
    const scratch = this.chat.scratchPath(conv.id)
    // Only files a person would see count: an agent's hidden config or cache alone doesn't make a folder.
    if (!existsSync(scratch) || !readdirSync(scratch).some((name) => !name.startsWith('.'))) return
    const own = this.chat.folderOf(conv)
    if (own) {
      // The user made a folder the working folder mid-reply: what the agent made before joins it, never over the user's files.
      if (!this.adopted.delete(conv.id)) return
      moveContents(scratch, own, { keepExisting: true })
      this.movedNotes.set(conv.id, t('（应用说明：这个对话的文件已从 {0} 移到 {1}，之后请在 {1} 里工作。）', scratch, own))
      return own
    }
    const root = this.autoFolderRoot()
    mkdirSync(root, { recursive: true })
    const target = uniqueDir(root, folderSafeName(conv.title, t('新对话')))
    moveContents(scratch, target)
    try { rmdirSync(scratch) } catch { /* the agent may still hold it open; it is empty either way */ }
    this.movedNotes.set(conv.id, t('（应用说明：这个对话的文件已从 {0} 移到 {1}，之后请在 {1} 里工作。）', scratch, target))
    // Not remembered as a recent folder: the user never chose it.
    this.chat.patchConversation(conv.id, { cwd: target, autoFolder: true })
    this.chat.forgetSession(conv.id)
    const reply = replyId ? this.store.messagesOf(conv.id).find((m) => m.id === replyId) : undefined
    if (reply) this.chat.updateMessage({ ...reply, blocks: [...reply.blocks, { type: 'placed', path: target }] })
    return target
  }

  /**
   * The 「在默认文件夹里新建」 button: a folder named after the chat or project
   * under the default folder, with whatever the agent already made moved in.
   */
  async makeDefaultFolder(id: string): Promise<string> {
    const root = this.autoFolderRoot()
    mkdirSync(root, { recursive: true })
    const project = this.store.projects.find((p) => p.id === id)
    if (project) {
      if (project.cwd) return project.cwd
      const target = uniqueDir(root, folderSafeName(project.name, t('新项目')))
      mkdirSync(target, { recursive: true })
      await this.updateProject(id, { cwd: target })
      return target
    }
    const conv = this.store.requireConversation(id)
    const has = this.chat.folderOf(conv)
    if (has) return has
    if (this.chat.isBusy(id)) throw new Error(t('等这条回复结束再建文件夹'))
    const target = uniqueDir(root, folderSafeName(conv.title, t('新对话')))
    mkdirSync(target, { recursive: true })
    const scratch = this.chat.scratchPath(id)
    if (existsSync(scratch)) {
      moveContents(scratch, target)
      try { rmdirSync(scratch) } catch { /* empty either way */ }
      this.movedNotes.set(id, t('（应用说明：这个对话的文件已从 {0} 移到 {1}，之后请在 {1} 里工作。）', scratch, target))
    }
    this.chat.patchConversation(id, { cwd: target, autoFolder: true })
    this.chat.forgetSession(id)
    return target
  }

  snapshot(): AppSnapshot {
    return {
      projects: this.store.projects,
      conversations: this.store.conversations,
      routines: this.store.routines,
      boardWidgets: this.store.boardWidgets,
      settings: this.store.settings,
      backends: this.backends.list(),
      platform: this.platform,
      peerMessages: this.store.peerMessages,
      permissions: this.chat.pendingRequests()
    }
  }

  messages(conversationId: string) {
    return this.store.messagesOf(conversationId)
  }

  // ---- chats --------------------------------------------------------------

  /**
   * The backend new work goes to: the one asked for, else the default, as long
   * as it isn't known to be missing; otherwise the first installed one (Codex
   * first). An agent that isn't installed is never picked on the user's behalf.
   */
  resolveBackend(preferred?: string): string {
    const list = this.backends.list()
    const ok = (id?: string): id is string => !!id && list.some((b) => b.id === id && b.installed !== false)
    if (ok(preferred)) return preferred
    const def = this.store.settings.defaultBackendId
    if (ok(def)) return def
    return this.firstInstalledBackend() ?? (preferred && this.backends.has(preferred) ? preferred : def)
  }

  /** The first installed agent in the preferred order (Codex first), if any is. */
  firstInstalledBackend(): string | undefined {
    const list = this.backends.list()
    const installed = (id: string) => list.some((b) => b.id === id && b.installed === true)
    return PREFERRED_BACKENDS.find(installed) ?? list.find((b) => b.installed === true)?.id
  }

  /**
   * Threads that were mid-task when the app quit pick their work back up, so a
   * restart doesn't silently drop work the user handed off.
   */
  /**
   * Points everything at a backend that exists: the demo agent is gone from the app,
   * and a backend can disappear from backends.json. Chats keep their history and
   * continue on the default backend, which gets the conversation so far.
   */
  /**
   * Ordinary chats never belong to a project (a project is its own chat plus
   * threads). Chats an earlier version filed into a project go back to the
   * chat list, under the project's folder when they had none of their own.
   */
  separateChatsFromProjects(): void {
    for (const c of this.store.conversations) {
      if (c.kind !== 'chat' || !c.projectId) continue
      const cwd = c.cwd || this.store.project(c.projectId)?.cwd || undefined
      this.chat.patchConversation(c.id, { projectId: undefined, cwd })
    }
  }

  /**
   * Before RC8, a Grok reply with nothing to report (a / command it answered itself) was given the
   * previous turn's usage from Grok's log, so the totals counted that turn twice. Take those copies out.
   */
  dropCopiedUsage(): void {
    for (const c of this.store.conversations) {
      if (c.backendId !== 'grok' || !c.usage) continue
      let usage = c.usage
      let prev: Message | undefined
      for (const m of this.store.messagesOf(c.id)) {
        if (m.role !== 'assistant') continue
        if (m.usage && !m.blocks.length && prev?.usage && JSON.stringify(prev.usage) === JSON.stringify(m.usage)) {
          usage = removeTurn(usage, m.usage)
          this.store.putMessage({ ...m, usage: undefined })
          continue
        }
        prev = m
      }
      if (usage !== c.usage) this.chat.patchConversation(c.id, { usage })
    }
  }

  /** Commands still listed as running when the app last quit ended with it. */
  endStaleCommands(): void {
    for (const c of this.store.conversations) {
      // Commands that ended within their reply were its steps, not background work (older versions listed them).
      const kept = c.background?.filter((b) => !b.endedAt || b.managed || b.detached)
      if (!c.background || (kept!.length === c.background.length && !kept!.some((b) => !b.endedAt))) continue
      this.chat.patchConversation(c.id, { background: kept!.map((b) => (b.endedAt ? b : { ...b, endedAt: b.startedAt, exitCode: null })) })
    }
  }

  /**
   * Chats an earlier version filed under the home folder (or a drive root) go back to having no folder.
   * So do a project's own conversations (its chat, its threads): they would otherwise keep working there.
   */
  leaveUnsafeFolders(): void {
    for (const c of this.store.conversations)
      if (this.unsafeFolder(c.cwd)) this.chat.patchConversation(c.id, { cwd: undefined, autoFolder: undefined })
    // A project there loses the folder too (its files pane then offers to make or pick one).
    for (const p of this.store.projects)
      if (this.unsafeFolder(p.cwd)) {
        const next = { ...p, cwd: undefined }
        this.store.putProject(next)
        this.publish({ type: 'project', project: next })
      }
    const recent = this.store.settings.recentFolders
    if (recent?.some((f) => this.unsafeFolder(f))) this.store.patchSettings({ recentFolders: recent.filter((f) => !this.unsafeFolder(f)) })
    // 常用文件夹 and 自动建的文件夹放在 are one setting now, the default folder. The old 常用文件夹 was
    // a folder to work in (often a repository), not a place for new folders: it stays a recent folder.
    const old = this.store.settings.defaultCwd
    if (old !== undefined) {
      const recentNow = this.store.settings.recentFolders ?? []
      const keep = old && !this.unsafeFolder(old) && !recentNow.includes(old)
      this.store.patchSettings({ defaultCwd: undefined, ...(keep ? { recentFolders: [old, ...recentNow] } : {}) })
    }
  }

  repairBackends(): void {
    const list = this.backends.list()
    if (!list.length) return
    // While backends.json is broken its backends only look missing: leave their chats alone
    // until the file is fixed. Only the retired demo agent is gone for good.
    const gone = (id: string) => !this.backends.has(id) && (!this.backendsConfigError || id === 'mock')
    // A default that is gone or not installed (an older version defaulted to Qoder) moves to an
    // installed agent, Codex first; with none installed it stays empty and Settings is the way in.
    const current = this.store.settings.defaultBackendId
    const missing = list.find((b) => b.id === current)?.installed === false
    if (!current || gone(current) || missing) {
      const next = this.firstInstalledBackend() ?? (missing || gone(current) ? '' : current)
      if (next !== current) this.publish({ type: 'settings', settings: this.store.patchSettings({ defaultBackendId: next }) })
    }
    // Chats on a vanished backend need some backend to show their history under; sending tells them what is missing.
    const def = this.store.settings.defaultBackendId || PREFERRED_BACKENDS.find((id) => this.backends.has(id)) || list[0].id
    for (const c of this.store.conversations)
      if (gone(c.backendId)) this.chat.patchConversation(c.id, { backendId: def, sessionRef: undefined, models: undefined, modelId: undefined, sessionOptions: undefined, optionValues: undefined })
    for (const p of this.store.projects)
      if (p.backendId && gone(p.backendId)) {
        const next = { ...p, backendId: def }
        this.store.putProject(next)
        this.publish({ type: 'project', project: next })
      }
    for (const r of this.store.routines)
      if (r.backendId && gone(r.backendId)) {
        const next = { ...r, backendId: undefined }
        this.store.putRoutine(next)
        this.publish({ type: 'routine', routine: next })
      }
  }

  /**
   * Defaults that point at an agent that isn't installed or isn't signed in (0.1.0's guide
   * defaulted to Qoder) move to one that is: signed in first, Codex first. Projects and
   * scheduled tasks on such an agent move too. Checks run once, in the background.
   */
  /** The startup check above, for whoever needs it finished. */
  signInRepair?: Promise<void>

  async repairSignIns(): Promise<void> {
    const list = this.backends.list()
    const installed = (id: string) => list.find((b) => b.id === id)?.installed === true
    const order = [...PREFERRED_BACKENDS, ...list.map((b) => b.id).filter((id) => !PREFERRED_BACKENDS.includes(id))].filter(installed)
    const seen = new Map<string, Promise<boolean | undefined>>()
    const signedIn = (id: string) => {
      if (!seen.has(id)) seen.set(id, this.backends.account(id).then((a) => a.signedIn, () => undefined))
      return seen.get(id)!
    }
    const usable = async (id: string) => list.find((b) => b.id === id)?.installed !== false && (await signedIn(id)) !== false
    let best: Promise<string | undefined> | undefined
    const pick = () =>
      (best ??= (async () => {
        for (const id of order) if ((await signedIn(id)) === true) return id
        for (const id of order) if ((await signedIn(id)) !== false) return id
        return undefined
      })())
    const def = this.store.settings.defaultBackendId
    if (def && !(await usable(def))) {
      const next = await pick()
      if (next && next !== def) this.publish({ type: 'settings', settings: this.store.patchSettings({ defaultBackendId: next }) })
    }
    // Projects and routines keep the backend the user chose; while it is signed out
    // they run on another one for now, and the reply says so.
    const chosen = new Set([...this.store.projects.filter((p) => !p.archived).map((p) => p.backendId), ...this.store.routines.map((r) => r.backendId)])
    for (const id of chosen) {
      if (!id || (await usable(id))) continue
      const next = await pick()
      if (next && next !== id) this.standIns.set(id, next)
    }
  }

  /** Backends found signed out, with the one projects and routines use meanwhile. Never saved. */
  readonly standIns = new Map<string, string>()

  /** A backend is signed in again: its projects and routines go back to it. */
  private signedInAgain(backendId: string): void {
    if (!this.standIns.delete(backendId)) return
    for (const c of this.store.conversations) if (c.backendId === backendId) this.chat.forgetSession(c.id)
  }

  resumeInterrupted(): void {
    for (const id of this.store.interrupted.splice(0)) {
      const c = this.store.conversation(id)
      if (!c || c.kind !== 'thread' || c.resolved) continue
      void this.chat.send(
        id,
        '（系统）应用刚才重启，你上一轮的工作被打断了。请根据进度清单和已有结果接着完成，已经完成的部分不用重做。',
        { hidden: true, housekeeping: true }
      )
    }
  }

  async startChat(opts: NewChatOptions): Promise<Conversation> {
    // Asking within a project goes to the project's own chat; it never makes a loose chat inside it.
    const project = this.store.project(opts.projectId)
    const projectChat = project && this.store.conversation(project.conversationId)
    if (projectChat) {
      await this.send(projectChat.id, opts.text, opts.attachments)
      return projectChat
    }
    this.refuseFolder(opts.cwd)
    const backendId = this.resolveBackend(opts.backendId)
    const id = this.chat.spareId(backendId, opts.cwd)
    const conv = this.chat.createConversation({
      ...(id ? { id } : {}),
      kind: 'chat',
      title: titleFrom(opts.text || opts.attachments?.[0]?.name || ''),
      backendId,
      cwd: opts.cwd || undefined,
      modelId: opts.modelId,
      optionValues: opts.optionValues && Object.keys(opts.optionValues).length ? { ...opts.optionValues } : undefined
    })
    if (opts.cwd) this.rememberFolder(opts.cwd)
    void this.chat.send(conv.id, opts.text, { attachments: opts.attachments })
    return conv
  }

  async send(conversationId: string, text: string, attachments?: Attachment[]): Promise<void> {
    await this.takePendingBackend(conversationId)
    const conv = this.store.conversation(conversationId)
    // Writing in a resolved thread reopens it, as in Claude Projects.
    if (conv?.resolved) this.chat.patchConversation(conversationId, { resolved: false })
    // The agent's own slash commands go to it as typed (ChatService decides once the session says which it has).
    void this.chat.send(conversationId, text, { attachments })
  }

  /**
   * The app's own / commands: /子对话 hands the text to a new sub-conversation of
   * a chat, /讨论串 starts a thread in a project. The user's line stays in the
   * conversation with the new card under it; the agent here is not asked.
   */
  async runCommand(conversationId: string, command: 'subchat' | 'thread', text: string): Promise<string> {
    const conv = this.store.requireConversation(conversationId)
    const task = text.trim()
    if (!task) throw new Error(t('请在命令后面写上要做的事'))
    const typed = `/${getLang() === 'en' ? command : command === 'subchat' ? '子对话' : '讨论串'} ${task}` // i18n-ignore
    if (command === 'subchat') {
      if (conv.kind !== 'chat' || conv.parentId) throw new Error(t('只有普通对话能开子对话，子对话里不能再开'))
      if (this.chat.isBusy(conv.id)) throw new Error(t('等这条回复结束再开子对话'))
      // The new chat can't see this one: it starts with its latest lines, and can read more itself.
      const recent = excerpt(this.store.messagesOf(conv.id).filter((m) => !m.hidden))
      this.chat.addMessage(conv.id, 'user', [{ type: 'text', text: typed }])
      const context = recent ? `主对话最近的内容（应用摘录，可能不完整；需要更多时用 read_parent_conversation 查看）：\n${recent}` : undefined
      return this.orchestrator.startSubconversation(conv, '', task, context).id
    }
    const project = this.store.project(conv.projectId)
    if (conv.kind !== 'project' || !project) throw new Error(t('只有项目的主对话能开讨论串'))
    const asked = this.chat.addMessage(conv.id, 'user', [{ type: 'text', text: typed }])
    return this.orchestrator.startThread(project, titleFrom(task), `用户原话：${task}`, undefined, asked).id
  }

  async regenerate(conversationId: string): Promise<void> {
    const list = this.store.messagesOf(conversationId)
    const lastUser = [...list].reverse().find((m) => m.role === 'user' && !m.hidden)
    if (!lastUser) return
    await this.takePendingBackend(conversationId)
    const { text, attachments } = splitUserMessage(lastUser)
    const variant = await this.chat.rewind(conversationId, lastUser.id)
    void this.chat.send(conversationId, text, { attachments, variant })
  }

  async editMessage(conversationId: string, messageId: string, text: string): Promise<void> {
    const m = this.store.message(conversationId, messageId)
    if (!m || m.role !== 'user') return
    await this.takePendingBackend(conversationId)
    const { attachments } = splitUserMessage(m)
    const variant = await this.chat.rewind(conversationId, messageId)
    void this.chat.send(conversationId, text, { attachments, variant })
  }

  switchVariant(conversationId: string, group: string, index: number) {
    return this.chat.switchVariant(conversationId, group, index)
  }

  cancel(conversationId: string) {
    return this.chat.cancel(conversationId)
  }

  queuedMessage(conversationId: string, id: string, action: 'now' | 'take') {
    return this.chat.queuedMessage(conversationId, id, action)
  }

  /** The stop control shown while an agent controls the computer: withdraw the grant and stop the turn. */
  stopComputer(conversationId: string) {
    this.computer?.revoke(conversationId)
    return this.chat.cancel(conversationId)
  }

  async setModel(conversationId: string, modelId: string): Promise<void> {
    const before = this.store.conversation(conversationId)
    if (!before) return
    // With no session yet, the conversation opens its own now: it tells this model's choices (thinking levels)
    // and the next message uses it, instead of a throwaway session now and another one at send.
    if (!this.chat.sessionLoad(conversationId) && this.backends.has(before.backendId)) {
      await this.chat.open(conversationId)
      if (this.store.conversation(conversationId)?.backendId !== before.backendId) return
      const offered = this.store.conversation(conversationId)?.models
      if (offered?.length && !offered.some((m) => m.id === modelId)) throw new Error(t('无法加载模型：{0}', modelId))
    }
    await this.chat.setModel(conversationId, modelId)
    const conv = this.store.conversation(conversationId)
    if (conv) {
      this.rememberModelDefault(conv.backendId, modelId)
      if (conv.models) this.chat.rememberModels(conv.backendId, conv.models, modelId, conv.sessionOptions)
    }
  }

  async setOption(conversationId: string, optionId: string, value: string): Promise<void> {
    await this.chat.setOption(conversationId, optionId, value)
    const conv = this.store.conversation(conversationId)
    const option = (conv?.sessionOptions ?? this.store.settings.backendModels?.[conv?.backendId ?? '']?.options)?.find((o) => o.id === optionId)
    if (conv && option && option.category !== 'mode') await this.setOptionDefault(conv.backendId, optionId, value, conv.modelId)
  }

  async setModelDefault(backendId: string, modelId: string): Promise<void> {
    const catalog = await this.backendModels(backendId, modelId)
    if (catalog.needsLogin) throw new Error(t('{0} 需要登录。可以在 设置 → Agent 后端 里点「登录」。', this.backends.list().find((b) => b.id === backendId)?.name ?? backendId))
    if (!catalog.models.some((m) => m.id === modelId)) throw new Error(t('无法加载模型：{0}', modelId))
    this.rememberModelDefault(backendId, modelId)
  }

  private rememberModelDefault(backendId: string, modelId: string): void {
    const all = this.store.settings.backendModelDefaults ?? {}
    this.publish({ type: 'settings', settings: this.store.patchSettings({ backendModelDefaults: { ...all, [backendId]: modelId } }) })
    if (all[backendId] !== modelId) void this.newChatModel(backendId)
  }

  /**
   * The model for new chats changed. An agent that takes it only when it starts runs again with it
   * (when no chat is open on it); the session opened ahead, on the old model, is made again after.
   */
  private async newChatModel(backendId: string): Promise<void> {
    const spare = this.chat.spareOf(backendId)
    this.chat.dropSpare(backendId)
    await this.backends.defaultModelChanged(backendId).catch(() => false)
    if (spare) this.chat.prepareSpare(backendId, spare.folder)
  }

  async setOptionDefault(backendId: string, optionId: string, value: string,
    modelId = this.store.settings.backendModelDefaults?.[backendId] ?? this.store.settings.backendModels?.[backendId]?.current): Promise<void> {
    const all = this.store.settings.backendOptionDefaults ?? {}
    const byModel = this.store.settings.backendModelOptionDefaults ?? {}
    const modelDefaults = modelId ? { ...byModel, [backendId]: { ...byModel[backendId], [modelId]: { ...byModel[backendId]?.[modelId], [optionId]: value } } } : byModel
    this.publish({ type: 'settings', settings: this.store.patchSettings({
      backendOptionDefaults: { ...all, [backendId]: { ...all[backendId], [optionId]: value } }, backendModelOptionDefaults: modelDefaults
    }) })
  }

  async backendAccount(backendId: string) {
    const status = await this.backends.account(backendId)
    if (status.signedIn === true) this.signedInAgain(backendId)
    return status
  }

  /** The new-chat composer shows this agent: start it now, so the first message doesn't wait for it. */
  async warmBackend(backendId: string, folder?: string): Promise<void> {
    if (!this.backends.has(backendId) || this.backends.list().find((b) => b.id === backendId)?.installed === false) return
    await this.backends.warm(backendId)
    // A new chat's composer: its session too, where opening one is slow.
    if (folder !== undefined && !this.unsafeFolder(folder)) this.chat.prepareSpare(backendId, folder)
  }

  /**
   * Starts the agents the user wants ready when the app opens (see prestartOn): installed and
   * signed in ones only, and no prompt is sent. The rest start once a chat with them is opened.
   */
  async prestartBackends(): Promise<void> {
    const settings = this.store.settings
    await Promise.all(
      this.backends
        .list()
        .filter((b) => b.installed !== false && prestartOn(settings, b.id))
        .map(async (b) => {
          const account = await this.backends.account(b.id).catch(() => ({}) as AccountStatus)
          if (account.installed === false || account.signedIn === false) return
          await this.backends.warm(b.id).catch(() => undefined)
          this.chat.prepareSpare(b.id)
        })
    )
  }

  async prepareConversation(conversationId: string): Promise<void> {
    this.chat.prepare(conversationId)
  }

  backendCredits(backendId: string, refresh = false) {
    return this.backends.credits(backendId, refresh)
  }

  private modelProbes = new Map<string, Promise<BackendModelCatalog>>()

  backendModels(backendId: string, modelId = this.store.settings.backendModelDefaults?.[backendId]): Promise<BackendModelCatalog> {
    const cached = this.store.settings.backendModels?.[backendId]
    if (cached?.models.length) {
      // Another known model answers at once. Its own choices (e.g. its thinking levels) are read behind the
      // scenes once the user stops picking: asking means starting a session of the agent, which takes seconds.
      if (modelId && cached.current !== modelId && cached.models.some((m) => m.id === modelId)) {
        clearTimeout(this.probeTimers.get(backendId))
        this.probeTimers.set(backendId, setTimeout(() => {
          this.probeTimers.delete(backendId)
          this.probeModels(backendId, modelId).catch(() => undefined)
        }, PROBE_SETTLE_MS).unref())
      }
      return Promise.resolve(cached)
    }
    return this.probeModels(backendId, modelId)
  }

  private probeTimers = new Map<string, NodeJS.Timeout>()

  /** Starts a session of the agent (no prompt) to read its models and choices; one at a time per model. */
  private probeModels(backendId: string, modelId: string | undefined): Promise<BackendModelCatalog> {
    const key = `${backendId}\0${modelId ?? ''}`
    const pending = this.modelProbes.get(key)
    if (pending) return this.notTooLong(key, backendId, pending)
    const probe = this.fromSpare(backendId, modelId).then((spare) => spare ?? this.backends.modelCatalog(backendId, modelId)).then((info) => {
      const catalog = { models: info.models ?? [], current: info.currentModelId, options: info.options }
      this.chat.rememberModels(backendId, catalog.models, catalog.current, catalog.options)
      return catalog
    }, (err: unknown): BackendModelCatalog => {
      // Signed out is a state the picker shows (with a way to sign in), not a failure.
      const kind = classifyError(err instanceof Error ? err.message : String(err))
      if (kind === 'auth' || kind === 'refresh') return { models: [], needsLogin: true }
      throw err
    }).finally(() => this.modelProbes.delete(key))
    this.modelProbes.set(key, probe)
    return this.notTooLong(key, backendId, probe)
  }

  /**
   * The models of the session opened ahead for the next new chat, when it opens on the model asked
   * about: reading them there opens no session of its own (each one costs Antigravity seconds and a helper process).
   */
  private async fromSpare(backendId: string, modelId: string | undefined) {
    const info = await this.chat.spareInfo(backendId)
    if (!info?.models?.length || (modelId && info.currentModelId !== modelId)) return undefined
    return info
  }

  /**
   * The picker stops waiting after a while and offers 重试; the probe itself goes on, and the
   * models it finds later are kept, so the retry answers from them (or joins the same probe).
   */
  private probeWaits = new Map<string, Promise<BackendModelCatalog>>()

  private notTooLong(key: string, backendId: string, probe: Promise<BackendModelCatalog>): Promise<BackendModelCatalog> {
    const waiting = this.probeWaits.get(key)
    if (waiting) return waiting
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(t('{0} 启动太久了，还没给出模型列表。', this.backends.nameOf(backendId)))), MODEL_PROBE_TIMEOUT_MS)
      timer.unref()
    })
    const wait = Promise.race([probe, late]).finally(() => {
      clearTimeout(timer)
      this.probeWaits.delete(key)
    })
    this.probeWaits.set(key, wait)
    return wait
  }

  /** Set by the Electron shell: open a file with its default app, or show it in its folder. */
  shellOpen?: (path: string, reveal: boolean) => Promise<string | undefined>
  /** Set by the Electron shell: moves a file or folder to the Recycle Bin / Trash (absent in tests: deleted outright). */
  shellTrash?: (path: string) => Promise<void>

  /** The OS file dialogs, set by the app shell (absent in tests: pickers answer null). */
  dialogs?: {
    openFolder(defaultPath?: string): Promise<string | null>
    saveFile(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>
  }
  /** backends.json, which 「打开配置文件夹」 reveals. */
  backendsFile?: string

  async pickFolder(start?: string): Promise<string | null> {
    // Opened at a known folder, not wherever Windows last was (often the desktop, whose
    // big files and shortcuts the picker reads before it answers).
    const defaultPath = [start, this.autoFolderRoot(), this.documentsDir].find((p) => !!p && existsSync(p))
    return (await this.dialogs?.openFolder(defaultPath)) ?? null
  }

  async exportConversation(id: string): Promise<boolean> {
    const conv = this.store.conversation(id)
    if (!conv) return false
    const path = await this.dialogs?.saveFile(`${conv.title.replace(/[\\/:*?"<>|]/g, '_')}.md`, [{ name: 'Markdown', extensions: ['md'] }])
    if (!path) return false
    writeFileSync(path, this.markdownOf(id))
    return true
  }

  async openConfigFolder(): Promise<void> {
    const file = this.backendsFile
    if (!file) return
    if (!existsSync(file)) writeFileSync(file, '[]\n')
    await this.shellOpen?.(file, true)
  }

  async openOutput(path: string, reveal = false): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(path)) return { ok: false, error: t('文件已不在原来的位置。') }
    // Programs and scripts are only ever shown in their folder, never run from a card.
    const opens = !reveal && (SAFE_TO_OPEN.test(path) || statSync(path).isDirectory())
    const err = await this.shellOpen?.(path, !opens)
    if (!err) return { ok: true }
    // The system's reason (often English, with the path) goes to the log.
    console.warn('[open]', err)
    return { ok: false, error: t('没能打开「{0}」，可能没有能打开它的应用。', basename(path)) }
  }



  backendLatestVersion(backendId: string) {
    return this.backends.latestVersion(backendId)
  }

  async upgradeBackend(backendId: string) {
    const r = await this.backends.upgrade(backendId, (line) => this.publish({ type: 'backend-upgrade', backendId, line }))
    const account = await this.backends.account(backendId)
    // The command worked but the program still can't be found: not a success the user can use.
    const notFound = r.ok && account.installed === false
    return { ok: r.ok && !notFound, notFound, output: r.output.slice(-4000), account }
  }

  /** The latest backend switch asked for in each conversation (see updateConversation). */
  private switches = new Map<string, number>()

  /**
   * Hands a conversation to another agent: a reply still running stops (what it said
   * stays, marked as cut off by the switch); the new agent gets the conversation so far.
   */
  private async switchBackend(id: string, nextBackendId: string): Promise<void> {
    // The latest choice wins: one made while an earlier switch waits for the reply to stop replaces it.
    const seq = (this.switches.get(id) ?? 0) + 1
    this.switches.set(id, seq)
    const reply = this.chat.currentReply(id)
    if (reply) {
      await this.chat.stopTurn(id)
      if (this.switches.get(id) !== seq) return
      const m = this.store.messagesOf(id).find((x) => x.id === reply.id)
      if (m && m.state === 'cancelled') this.chat.updateMessage({ ...m, switchedTo: this.backends.list().find((b) => b.id === nextBackendId)?.name ?? nextBackendId })
    }
    const before = this.store.conversation(id)
    if (!before) return
    this.chat.forgetSession(id)
    this.chat.patchConversation(id, { backendId: nextBackendId, nextBackendId: undefined, sessionRef: undefined, models: undefined,
      modelId: this.store.settings.backendModelDefaults?.[nextBackendId], sessionOptions: undefined, optionValues: undefined, status: 'idle',
      // The ring shows the new agent's context, which starts empty.
      usage: before.usage && { ...before.usage, contextUsed: undefined, contextSize: undefined, contextSource: undefined, contextSizeSource: undefined } })
    if (before.kind === 'project') {
      const project = this.store.project(before.projectId)
      if (project) {
        const next = { ...project, backendId: nextBackendId }
        this.store.putProject(next)
        this.publish({ type: 'project', project: next })
      }
    }
  }

  /** A backend picked during a reply takes over when the next message goes out. */
  private async takePendingBackend(id: string): Promise<void> {
    const next = this.store.conversation(id)?.nextBackendId
    if (next && this.backends.has(next)) await this.switchBackend(id, next)
    else if (next) this.chat.patchConversation(id, { nextBackendId: undefined })
  }

  async updateConversation(id: string, patch: Partial<Conversation>): Promise<void> {
    const before = this.store.conversation(id)
    if (before?.kind === 'chat' && 'projectId' in patch) {
      const { projectId: _ignored, ...rest } = patch
      patch = rest
    }
    if (before && patch.backendId !== undefined) {
      const { backendId: next, ...rest } = patch
      patch = rest
      if (!this.backends.has(next)) throw new Error(t('后端「{0}」已经不存在了', next))
      // Mid-reply the choice waits for the next message: that one stops the reply, if it still runs, then switches.
      if (next === before.backendId) {
        if (before.nextBackendId) this.chat.patchConversation(id, { nextBackendId: undefined })
      } else if (this.chat.currentReply(id)) this.chat.patchConversation(id, { nextBackendId: next })
      else await this.switchBackend(id, next)
    }
    // A title the user typed is theirs; the app stops improving it.
    if ('title' in patch) patch = { ...patch, titleAuto: false }
    // A folder the user picks is theirs, even in place of one the app made.
    if ('cwd' in patch) {
      this.refuseFolder(patch.cwd)
      patch = { ...patch, autoFolder: undefined }
    }
    this.chat.patchConversation(id, patch)
    // A session is tied to its folder: the next turn starts a new one there, with the conversation so far.
    if ('cwd' in patch && before && (before.cwd || undefined) !== (patch.cwd || undefined)) this.chat.forgetSession(id)
    if ('cwd' in patch) this.rememberFolder(patch.cwd)
  }

  async deleteConversation(id: string): Promise<void> {
    // A project's own chat goes only with its project: without it the project can't open.
    const c = this.store.conversation(id)
    if (c?.kind === 'project' && this.store.project(c.projectId)) throw new Error(t('这是项目的主对话，不能单独删除。要删除，请删除整个项目。'))
    return this.dropConversation(id)
  }

  private async dropConversation(id: string): Promise<void> {
    const gone = this.store.conversation(id)
    if (!gone) return
    // Its card goes from where it was started: a thread's from the project chat, a sub-chat's from its parent.
    const startedIn = gone.parentId ?? (gone.anchorMessageId ? this.store.project(gone.projectId)?.conversationId : undefined)
    if (startedIn) this.chat.stripBlocks(startedIn, (b) => b.type === 'thread-card' && b.threadId === id)
    // A deleted parent's sub-chats become chats of their own.
    for (const child of this.store.conversations.filter((c) => c.parentId === id)) this.chat.patchConversation(child.id, { parentId: undefined })
    await this.chat.removeConversation(id)
  }

  async sendToThread(projectConversationId: string, threadId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const coordinator = this.store.conversation(projectConversationId)
    const thread = this.store.conversation(threadId)
    if (!coordinator || coordinator.kind !== 'project' || thread?.kind !== 'thread' || thread.projectId !== coordinator.projectId)
      throw new Error(t('找不到这个讨论串'))
    // The project chat keeps one line; the coordinator never sees it.
    this.chat.addMessage(coordinator.id, 'system', [{ type: 'thread-event', threadId, kind: 'forwarded', text: text.slice(0, 300) }])
    if (thread.resolved) this.chat.patchConversation(threadId, { resolved: false })
    await this.takePendingBackend(threadId)
    await this.chat.send(threadId, text, { attachments })
  }

  async compactContext(conversationId: string): Promise<void> {
    await this.chat.compactContext(conversationId)
  }

  async commandOutput(conversationId: string, id: string): Promise<string> {
    return this.chat.commandOutput(conversationId, id)
  }

  async stopCommand(conversationId: string, id: string): Promise<void> {
    await this.chat.stopCommand(conversationId, id)
  }

  async cancelPeerMessage(id: string): Promise<void> {
    this.peers.cancel(id)
  }

  async react(messageId: string, conversationId: string, emoji: string): Promise<void> {
    const m = this.store.message(conversationId, messageId)
    if (!m) return
    const set = new Set(m.reactions ?? [])
    set.has(emoji) ? set.delete(emoji) : set.add(emoji)
    m.reactions = [...set]
    this.chat.updateMessage(m)
  }

  async artifactInfo(id: string) {
    const m = this.artifacts.meta(id)
    return m ? { id: m.id, title: m.title, versions: m.versions } : null
  }

  async artifactSource(id: string, version?: number) {
    return this.artifacts.html(id, version) ?? null
  }

  async chooseDecision(conversationId: string, messageId: string, blockIndex: number, option: number): Promise<void> {
    const m = this.store.message(conversationId, messageId)
    const b = m?.blocks[blockIndex]
    if (!m || b?.type !== 'decision' || b.chosen !== undefined || !b.options[option]) return
    b.chosen = option
    this.chat.updateMessage(m)
    this.chat.patchConversation(conversationId, { needsUser: undefined })
    await this.send(conversationId, t('关于「{0}」，我选：{1}', b.question, b.options[option].label))
  }

  // ---- projects -----------------------------------------------------------

  async createProject(p: { name: string; description?: string; instructions?: string; cwd?: string; backendId?: string }): Promise<Project> {
    const now = Date.now()
    const id = randomUUID()
    const backendId = this.resolveBackend(p.backendId)
    this.refuseFolder(p.cwd)
    this.rememberFolder(p.cwd)
    // A project the user gave no folder gets its own under the default folder, named after it.
    if (!p.cwd) {
      const root = this.autoFolderRoot()
      mkdirSync(root, { recursive: true })
      p = { ...p, cwd: uniqueDir(root, folderSafeName(p.name, t('新项目'))) }
      mkdirSync(p.cwd!, { recursive: true })
    }
    const conv = this.chat.createConversation({ kind: 'project', title: p.name, projectId: id, backendId, cwd: p.cwd })
    const project: Project = {
      id,
      name: p.name,
      description: p.description,
      instructions: p.instructions,
      cwd: p.cwd,
      backendId,
      conversationId: conv.id,
      createdAt: now,
      updatedAt: now
    }
    this.store.putProject(project)
    this.publish({ type: 'project', project })
    return project
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<void> {
    const p = this.store.project(id)
    if (!p) return
    if (patch.cwd) this.refuseFolder(patch.cwd)
    const next = { ...p, ...patch, updatedAt: Date.now() }
    this.store.putProject(next)
    this.publish({ type: 'project', project: next })
    if (patch.name) this.chat.patchConversation(p.conversationId, { title: patch.name })
    if ('archived' in patch && !!patch.archived !== !!p.archived) {
      this.pauseRoutinesFor(id, !!patch.archived)
      this.peers.soon()
    }
    if ('cwd' in patch) this.rememberFolder(patch.cwd)
    if ('cwd' in patch && (p.cwd || undefined) !== (patch.cwd || undefined)) {
      // The project chat and its threads work in the project's folder.
      for (const c of this.store.conversations.filter((c) => c.projectId === id && c.kind !== 'chat')) {
        this.chat.patchConversation(c.id, { cwd: patch.cwd || undefined })
        this.chat.forgetSession(c.id)
      }
    }
  }

  // ---- folders ----------------------------------------------------------------

  /** Scans for likely project folders; tests point it elsewhere. */
  folderFinder = new FolderFinder()

  async foldersInText(text: string): Promise<string[]> {
    return foldersInText(String(text ?? '').slice(0, 20_000))
  }

  async suggestFolders(hint: string, onlyMatching = false): Promise<FolderCandidate[]> {
    const list = await this.folderFinder.scan()
    return (onlyMatching ? matchingFolders(list, hint) : rankFolders(list, hint)).slice(0, 6)
  }

  /** Keeps the folders the user works in, so they are offered again even after the chat is gone. */
  private rememberFolder(dir?: string): void {
    if (!dir || this.unsafeFolder(dir)) return
    const list = this.store.settings.recentFolders ?? []
    if (list[0] === dir) return
    const next = [dir, ...list.filter((f) => f !== dir)].slice(0, 12)
    this.publish({ type: 'settings', settings: this.store.patchSettings({ recentFolders: next }) })
  }

  // ---- progress board -------------------------------------------------------

  private applyProgress(projectId: string, patch: ProgressPatch, by: 'user' | 'agent' | 'app'): ProgressItem {
    const p = this.store.requireProject(projectId)
    const { items, item } = applyPatch(p.progress ?? [], patch, by)
    const next = { ...p, progress: items, updatedAt: Date.now() }
    this.store.putProject(next)
    this.publish({ type: 'project', project: next })
    return item
  }

  async updateProgress(projectId: string, patch: ProgressPatch): Promise<ProgressItem> {
    return this.applyProgress(projectId, patch, 'user')
  }

  async deleteProgress(projectId: string, id: string): Promise<void> {
    const p = this.store.project(projectId)
    if (!p) return
    const next = { ...p, progress: removeItem(p.progress ?? [], id), updatedAt: Date.now() }
    this.store.putProject(next)
    this.publish({ type: 'project', project: next })
  }

  async deleteProject(id: string): Promise<void> {
    for (const c of this.store.conversations.filter((c) => c.projectId === id)) {
      if (c.kind === 'chat') this.chat.patchConversation(c.id, { projectId: undefined })
      else await this.dropConversation(c.id)
    }
    this.store.removeProject(id)
    this.publish({ type: 'project-removed', id })
  }

  // ---- routines (scheduler lives elsewhere; this is CRUD) ---------------------

  async saveRoutine(input: Omit<Routine, 'id' | 'createdAt'> & { id?: string }): Promise<Routine> {
    const prev = input?.id ? this.store.routines.find((x) => x.id === input.id) : undefined
    // It comes over IPC: a routine the scheduler or the routines page can't read is refused here.
    const r = { ...input, target: input?.target ?? prev?.target ?? {} }
    if (!validRoutine({ ...prev, ...r })) throw new Error(t('定时任务的内容不完整：需要名称、提示词和有效的时间安排。'))
    const merged = { ...prev, ...r, id: r.id ?? randomUUID(), createdAt: prev?.createdAt ?? Date.now(), lastError: undefined } as Routine
    // Turning it on (or off) by hand is the user's call from now on.
    if ('enabled' in r && r.enabled !== prev?.enabled) merged.pausedByArchive = undefined
    // Changing the schedule restarts its clock.
    if (prev && JSON.stringify(prev.schedule) !== JSON.stringify(r.schedule)) merged.lastRunAt = undefined
    const routine = this.scheduler.schedule(merged)
    this.store.putRoutine(routine)
    this.publish({ type: 'routine', routine })
    return routine
  }


  /** An archived project's routines stop running unseen; restoring it turns back on the ones archiving paused. */
  private pauseRoutinesFor(projectId: string, archived: boolean): void {
    const inProject = (r: Routine) =>
      r.target.projectId === projectId || (!!r.target.conversationId && this.store.conversation(r.target.conversationId)?.projectId === projectId)
    for (const r of this.store.routines.filter(inProject)) {
      if (archived ? !r.enabled : !r.pausedByArchive) continue
      const routine = this.scheduler.schedule({ ...r, enabled: !archived, pausedByArchive: archived || undefined })
      this.store.putRoutine(routine)
      this.publish({ type: 'routine', routine })
    }
  }

  async runRoutineNow(id: string): Promise<void> {
    void this.scheduler.run(id)
  }

  async deleteRoutine(id: string): Promise<void> {
    const r = this.store.routines.find((x) => x.id === id)
    this.store.removeRoutine(id)
    this.publish({ type: 'routine-removed', id })
    // A card it refreshed keeps its last data.
    const w = r?.widgetId && this.store.boardWidgets.find((x) => x.id === r.widgetId)
    if (w && w.routineId === id) this.putBoardWidget({ ...w, routineId: undefined })
  }

  // ---- home board ---------------------------------------------------------

  /** Adds or replaces a card; a new one also goes on the board when the user has arranged it. */
  putBoardWidget(w: BoardWidget): void {
    const isNew = !this.store.boardWidgets.some((x) => x.id === w.id)
    this.store.putBoardWidget(w)
    this.publish({ type: 'board-widget', widget: w })
    const layout = this.store.settings.homeWidgets
    if (isNew && layout && !layout.includes(boardWidgetKey(w.id))) this.publish({ type: 'settings', settings: this.store.patchSettings({ homeWidgets: [...layout, boardWidgetKey(w.id)] }) })
  }

  /** Deletes a card, and the routine that refreshed it. */
  async deleteBoardWidget(id: string): Promise<void> {
    const w = this.store.boardWidgets.find((x) => x.id === id)
    if (!w) return
    this.store.removeBoardWidget(id)
    this.publish({ type: 'board-widget-removed', id })
    if (w.routineId) await this.deleteRoutine(w.routineId)
    const layout = this.store.settings.homeWidgets
    if (layout?.includes(boardWidgetKey(id))) this.publish({ type: 'settings', settings: this.store.patchSettings({ homeWidgets: layout.filter((x) => x !== boardWidgetKey(id)) }) })
  }

  // ---- project memory -----------------------------------------------------

  async listMemory(projectId: string) {
    return this.memory.list(projectId)
  }

  async saveMemory(projectId: string, e: { name: string; description: string; type?: string; body: string }): Promise<void> {
    this.memory.write(projectId, e)
  }

  async deleteMemory(projectId: string, name: string): Promise<void> {
    this.memory.remove(projectId, name)
  }

  // ---- project files ------------------------------------------------------

  async listProjectFiles(projectId: string) {
    return this.files.list(projectId).map(({ name, size, updatedAt }) => ({ name, size, updatedAt }))
  }

  async addProjectFiles(projectId: string, files: { name: string; data: string }[]): Promise<void> {
    for (const f of files) this.files.add(projectId, f.name, f.data)
  }

  async deleteProjectFile(projectId: string, name: string): Promise<void> {
    this.files.remove(projectId, name)
  }

  // ---- files panel (a project's 库, a chat's files) -----------------------

  /** The working folder behind the files panel of a project or a conversation, and the conversations whose changes it shows. */
  private libraryOf(id: string): { root?: string; convs: string[] } {
    const project = this.store.projects.find((p) => p.id === id)
    if (project) return { root: project.cwd, convs: this.store.conversations.filter((c) => c.projectId === id).map((c) => c.id) }
    const conv = this.store.conversations.find((c) => c.id === id)
    if (!conv) return { convs: [] }
    const root = conv.cwd ?? (conv.projectId ? this.store.projects.find((p) => p.id === conv.projectId)?.cwd : undefined)
    return { root, convs: [conv.id, ...this.store.conversations.filter((c) => c.parentId === conv.id).map((c) => c.id)] }
  }

  async listLibrary(id: string, rel = '') {
    const { root } = this.libraryOf(id)
    if (!root || !existsSync(root)) return undefined
    const list = listFolder(root, rel)
    return list && { root, ...list }
  }

  async libraryChanges(id: string) {
    const { root, convs } = this.libraryOf(id)
    if (!root) return []
    return changedFiles(root, convs.flatMap((c) => this.store.messagesOf(c)), convs.map((c) => this.chat.scratchPath(c)))
  }

  async readLibraryFile(id: string, rel: string) {
    const { root } = this.libraryOf(id)
    return root ? this.fileOp(rel.split('/').pop() ?? rel, () => readPreview(root, rel), (n) => t('没能读取「{0}」。', n)) : undefined
  }

  /**
   * Where a file shown in a chat lives: in that conversation's or its project's folder (opened
   * there, editable), or elsewhere (shown read only). `near`: the conversation it was shown in.
   */
  async locateFile(path: string, near?: string): Promise<{ libraryId?: string; rel?: string }> {
    const conv = near ? this.store.conversation(near) : undefined
    // Only the folders of the conversation the link is in (and its project): a file anywhere else opens view-only.
    const ids = conv ? [conv.id, ...(conv.projectId ? [conv.projectId] : [])] : []
    for (const id of ids) {
      const { root } = this.libraryOf(id)
      if (!root) continue
      const rel = relative(resolve(root), resolve(path))
      if (rel && !rel.startsWith('..') && !isAbsolute(rel) && inside(root, rel)) return { libraryId: id, rel: rel.split(sep).join('/') }
    }
    return {}
  }

  /** A file outside every working folder, to look at in the app: always read only. */
  async readLocalFile(path: string) {
    if (!isAbsolute(path)) return undefined
    const r = this.fileOp(basename(path), () => readPreview(dirname(path), basename(path)), (n) => t('没能读取「{0}」。', n))
    return r && { ...r, readOnly: r.readOnly ?? (r.text !== undefined ? 'outside' : undefined) }
  }

  async openLibraryPath(id: string, rel: string, reveal = false) {
    const { root } = this.libraryOf(id)
    const abs = root && inside(root, rel)
    if (!abs) return { ok: false, error: t('文件已不在原来的位置。') }
    return this.openOutput(abs, reveal)
  }

  async addToLibrary(id: string, rel: string, files: { name: string; data: string }[]) {
    const { root } = this.libraryOf(id)
    if (!root) throw new Error(t('还没有文件夹。'))
    for (const f of files)
      if (!this.fileOp(f.name, () => addFile(root, rel, f.name, Buffer.from(f.data, 'base64')), (n) => t('无法添加 {0}', n))) throw new Error(t('无法添加 {0}', f.name))
  }

  private libraryRoot(id: string): string {
    const { root } = this.libraryOf(id)
    if (!root || !existsSync(root)) throw new Error(t('还没有文件夹。'))
    return root
  }

  private refused(r: LibraryRefusal, name: string): never {
    throw new Error(
      r === 'name'
        ? t('「{0}」不能用作文件名。', name)
        : r === 'taken'
          ? t('这里已经有「{0}」了。', name)
          : r === 'changed'
            ? t('文件在您编辑时被改过。')
            : r === 'encoding'
              ? t('这个文件不是 UTF-8 编码，在这里保存会弄坏它。')
              : t('文件已不在原来的位置。')
    )
  }

  /**
   * A change to the folder, with the system's errors (EEXIST, EACCES…) in words. What the system
   * said, with the path, goes to the log; the user reads a sentence. `what`: the sentence for any other error.
   */
  private fileOp<T>(name: string, op: () => T, what: (name: string) => string): T {
    try {
      return op()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      console.warn('[library]', e instanceof Error ? e.message : String(e))
      if (code === 'EEXIST') this.refused('taken', name)
      if (code === 'ENOENT') this.refused('gone', name)
      if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') throw new Error(t('没有权限修改「{0}」，或它正被别的程序占用。', name))
      if (code === 'ELOOP') throw new Error(t('「{0}」是一个链接，不能在这里编辑。', name))
      if (code === 'ENOSPC') throw new Error(t('磁盘空间不够，没能保存「{0}」。', name))
      throw new Error(what(name))
    }
  }

  async renameLibraryPath(id: string, rel: string, name: string) {
    const r = this.fileOp(name.trim(), () => renameEntry(this.libraryRoot(id), rel, name), (n) => t('没能重命名为「{0}」。', n))
    return 'refused' in r ? this.refused(r.refused, name.trim()) : r.path
  }

  async createLibraryEntry(id: string, rel: string, name: string, dir: boolean) {
    const r = this.fileOp(name.trim(), () => createEntry(this.libraryRoot(id), rel, name, dir), (n) => t('没能新建「{0}」。', n))
    return 'refused' in r ? this.refused(r.refused, name.trim()) : r.path
  }

  async saveLibraryFile(id: string, rel: string, text: string, since?: number, force?: boolean, recreate?: boolean) {
    const name = rel.split('/').pop() ?? rel
    const root = this.libraryRoot(id)
    const save = () => this.fileOp(name, () => writeText(root, rel, text, since, force), (n) => t('没能保存「{0}」。', n))
    let r = save()
    if ('refused' in r && r.refused === 'gone' && recreate) {
      // Made again where it was (its folder too, if that went); never over something now in its place.
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      const made = this.fileOp(name, () => createEntry(root, parent, name, false), (n) => t('没能保存「{0}」。', n))
      if ('refused' in made) return this.refused(made.refused, name)
      force = true
      r = save()
    }
    if ('refused' in r) return r.refused === 'changed' ? { conflict: true } : r.refused === 'gone' ? { gone: true } : this.refused(r.refused, name)
    return { updatedAt: r.updatedAt }
  }

  /** Moves a file or folder of it (a link: the link) to the Recycle Bin (Trash); never the folder itself. */
  async deleteLibraryPath(id: string, rel: string) {
    const abs = removablePath(this.libraryRoot(id), rel)
    if (!abs) throw new Error(t('文件已不在原来的位置。'))
    if (this.shellTrash) {
      try {
        await this.shellTrash(abs)
      } catch (e) {
        console.warn('[library]', e instanceof Error ? e.message : String(e))
        throw new Error(t('没能把「{0}」移到回收站，它可能正被别的程序占用。', rel.split('/').pop() ?? rel))
      }
    } else this.fileOp(rel.split('/').pop() ?? rel, () => rmSync(abs, { recursive: true }), (n) => t('没能删除「{0}」。', n))
  }

  // ---- connectors ---------------------------------------------------------

  async listConnectors(): Promise<ConnectorView[]> {
    return this.store.connectors.map(view)
  }

  async saveConnector(
    input: Omit<Connector, 'id' | 'secrets'> & { id?: string; secrets?: Record<string, string> }
  ): Promise<ConnectorView> {
    const prev = this.store.connectors.find((c) => c.id === input.id)
    const name = input.name.trim()
    if (!name) throw new Error(t('请填写名称'))
    if (name.toLowerCase() === 'fenn') throw new Error(t('fenn 是应用自己的工具名，请换一个名称'))
    if (input.kind === 'http' && !/^https?:\/\//.test(input.url ?? '')) throw new Error(t('请填写 http(s) 开头的地址'))
    if (input.kind === 'command' && !input.command?.trim()) throw new Error(t('请填写要运行的命令'))
    const secrets = { ...(prev?.secrets ?? {}) }
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      if (v === '') delete secrets[k]
      else secrets[k] = this.secrets.seal(v)
    }
    const c: Connector = {
      id: prev?.id ?? randomUUID(),
      name,
      enabled: input.enabled,
      kind: input.kind,
      command: input.kind === 'command' ? input.command!.trim() : undefined,
      args: input.kind === 'command' ? (input.args ?? []).filter(Boolean) : undefined,
      url: input.kind === 'http' ? input.url!.trim() : undefined,
      secrets
    }
    this.store.putConnector(c)
    this.refreshSessions()
    return view(c)
  }

  async deleteConnector(id: string): Promise<void> {
    this.store.removeConnector(id)
    this.refreshSessions()
  }

  private connectorServers(): HostToolServer[] {
    return this.store.connectors
      .filter((c) => c.enabled)
      .map((c) => {
        const secrets = Object.fromEntries(Object.entries(c.secrets ?? {}).map(([k, v]) => [k, this.secrets.unseal(v)]))
        return c.kind === 'http'
          ? { name: c.name, url: c.url!, headers: secrets }
          : { name: c.name, command: home(c.command!), args: (c.args ?? []).map(home), env: secrets }
      })
  }

  /** Tool lists are fixed per agent session, so idle sessions start over (with context) to pick up changes. */
  private refreshSessions(): void {
    for (const c of this.store.conversations) if (!this.chat.isBusy(c.id)) this.chat.forgetSession(c.id)
  }

  /** A conversation as Markdown, for exporting. */
  markdownOf(conversationId: string): string {
    const c = this.store.conversation(conversationId)
    if (!c) throw new Error(t('对话不存在'))
    const out = [`# ${c.title}`, '']
    for (const m of this.store.messagesOf(conversationId)) {
      if (m.hidden) continue
      const text = textOf(m).trim()
      const files = m.blocks.flatMap((b) => (b.type === 'attachment' ? [b.attachment.name] : []))
      if (!text && !files.length) continue
      const who = m.role === 'user' ? this.store.settings.userName || t('我') : m.role === 'assistant' ? 'Agent' : t('系统')
      out.push(`## ${who} · ${new Date(m.createdAt).toLocaleString(localeTag())}`, '')
      if (files.length) out.push(t('附件：{0}', files.join(t('、'))), '')
      if (text) out.push(text, '')
    }
    return out.join('\n')
  }

  // ---- search -------------------------------------------------------------

  /** Full-text search over every visible message, newest first. */
  async search(query: string, limit = 60): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase()
    // One Chinese/Japanese/Korean character is a meaningful query; one Latin letter isn't.
    if (!q || (q.length < 2 && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(q))) return []
    const hits: SearchHit[] = []
    for (const c of this.store.conversations) {
      for (const m of this.store.messagesOf(c.id)) {
        if (m.hidden || m.role === 'system') continue
        const text = textOf(m)
        const i = text.toLowerCase().indexOf(q)
        if (i < 0) continue
        const from = Math.max(0, i - 40)
        hits.push({
          conversationId: c.id,
          messageId: m.id,
          role: m.role,
          createdAt: m.createdAt,
          snippet: (from > 0 ? '…' : '') + text.slice(from, i + q.length + 80).replace(/\s+/g, ' ')
        })
      }
    }
    return hits.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
  }

  // ---- backend sign-in ----------------------------------------------------

  async backendAuthMethods(backendId: string) {
    return this.backends.authMethods(backendId)
  }

  async backendLogin(backendId: string, methodId: string) {
    await this.backends.authenticate(backendId, methodId)
    // Sessions created before signing in may be unusable; start fresh.
    for (const c of this.store.conversations) if (c.backendId === backendId) this.chat.forgetSession(c.id)
    const status = await this.backends.account(backendId)
    if (status.signedIn === true) this.signedInAgain(backendId)
    if (status.signedIn === false) throw new Error(t('登录尚未完成。请检查登录窗口或终端里的错误。') + (status.detail ? `\n${status.detail}` : ''))
    return status
  }

  /** Opens a visible terminal; set by the app shell (tests stub it). */
  openTerminal?: (command: string, args: string[]) => Promise<void>

  async backendTerminalLogin(backendId: string): Promise<void> {
    const cmd = this.backends.loginCommand(backendId)
    if (!cmd) throw new Error(t('这个后端没有登录命令'))
    if (!this.openTerminal) throw new Error(t('请自己打开一个终端，运行：{0}', [cmd.command, ...cmd.args].join(' ')))
    await this.openTerminal(cmd.command, cmd.args)
    // The running agent may have read its credentials at startup; the next use starts it fresh.
    await this.backends.restart(backendId, t('正在重新登录，后端已重新启动。登录完成后请点「重试」。'))
    for (const c of this.store.conversations) if (c.backendId === backendId) this.chat.forgetSession(c.id)
  }

  // ---- settings -----------------------------------------------------------

  /** Where the opt-in ACP debug log goes. */
  get logDir(): string {
    return join(this.store.dir, 'logs')
  }

  async openLogFolder(): Promise<void> {
    mkdirSync(this.logDir, { recursive: true })
    await this.shellOpen?.(this.logDir, false)
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    const was = !!this.store.settings.computerUse
    const settings = this.store.patchSettings(patch)
    if (!!settings.computerUse !== was) this.chat.refreshTools()
    if ('acpDebugLog' in patch) setAcpDebugLog(settings.acpDebugLog ? this.logDir : undefined)
    this.publish({ type: 'settings', settings })
    this.onSettingsChanged?.(settings)
  }

  /** Set by the app shell (e.g. to follow a language change in menus and notifications). */
  onSettingsChanged?: (settings: AppSettings) => void

  /** Re-reads the plugin list (e.g. after editing backends.json), set by the app shell. */
  reloadPlugins?: () => BackendPlugin[]

  /** Why backends.json couldn't be used, if it couldn't (the last good backends stay active). */
  backendsConfigError?: string

  async reloadBackends(): Promise<{ backends: BackendSummary[]; error?: string }> {
    if (this.reloadPlugins) {
      try {
        const restarted = await this.backends.setPlugins(this.reloadPlugins())
        const models = { ...this.store.settings.backendModels }
        for (const id of Object.keys(models)) if (restarted.includes(id) || !this.backends.has(id)) delete models[id]
        this.publish({ type: 'settings', settings: this.store.patchSettings({ backendModels: models }) })
        this.backendsConfigError = undefined
      } catch (e) {
        this.backendsConfigError = e instanceof Error ? e.message : String(e)
      }
    }
    this.repairBackends()
    void this.repairSignIns().catch(() => undefined)
    const list = this.backends.list()
    this.publish({ type: 'backends', backends: list })
    return { backends: list, error: this.backendsConfigError }
  }

  /** Filled in by the Electron entry point (version, commit, runtime versions). */
  info: AppInfo = { name: 'Fenn Code', version: '0.0.0', platform: process.platform, arch: process.arch }
  /**
   * Where to look for a newer version: a JSON document like
   * {"version":"0.2.0","url":"https://…","notes":"…"}. Unset until the app has a release channel.
   */
  updateFeed?: string
  fetchJson: (url: string) => Promise<unknown> = async (url) => (await fetch(url)).json()

  async convertToThread(conversationId: string, messageId: string): Promise<void> {
    this.orchestrator.convertToThread(conversationId, messageId)
  }

  usageCalendar(): Promise<UsageSummary> {
    return this.calendar.summary()
  }

  appInfo(): AppInfo {
    return { ...this.info, defaultFolder: this.defaultFolder(), updates: !!this.updateFeed }
  }

  async checkForUpdates(): Promise<UpdateCheck> {
    if (!this.updateFeed) return { status: 'unconfigured' }
    try {
      const feed = (await this.fetchJson(this.updateFeed)) as { version?: unknown; url?: unknown; notes?: unknown }
      if (typeof feed?.version !== 'string') throw new Error(t('更新信息格式不对'))
      if (compareVersions(feed.version, this.info.version) <= 0) return { status: 'latest', version: this.info.version }
      return {
        status: 'available',
        version: feed.version,
        url: typeof feed.url === 'string' && /^https:\/\//.test(feed.url) ? feed.url : undefined,
        notes: typeof feed.notes === 'string' ? feed.notes.slice(0, 2000) : undefined
      }
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  backendsConfigStatus(): { error?: string; example: string } {
    return { error: this.backendsConfigError, example: BACKENDS_EXAMPLE }
  }

  async setBackendSetting(backendId: string, key: string, value: string): Promise<void> {
    await this.backends.setSetting(backendId, key, value)
    const models = { ...this.store.settings.backendModels }
    delete models[backendId]
    this.publish({ type: 'settings', settings: this.store.patchSettings({ backendModels: models }) })
    for (const c of this.store.conversations) if (c.backendId === backendId) this.chat.forgetSession(c.id)
    this.publish({ type: 'backends', backends: this.backends.list() })
  }

  async respondPermission(requestId: string, decision: string | null): Promise<void> {
    this.chat.respondPermission(requestId, decision)
  }
}

function splitUserMessage(m: Message): { text: string; attachments: Attachment[] } {
  return {
    text: m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    attachments: m.blocks.flatMap((b) => (b.type === 'attachment' ? [b.attachment] : []))
  }
}

/** Commands run without a shell, so expand ~ the way users expect. */
function home(arg: string): string {
  return arg === '~' || arg.startsWith('~/') ? homedir() + arg.slice(1) : arg
}

function view(c: Connector): ConnectorView {
  const { secrets, ...rest } = c
  return { ...rest, secretKeys: Object.keys(secrets ?? {}) }
}

/** Compares dotted versions numerically (1.10.0 > 1.9.2); a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2)
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre && !y.pre) return -1
  if (!x.pre && y.pre) return 1
  return (x.pre ?? '').localeCompare(y.pre ?? '')
}

/** The answer to a computer-control access prompt: null when declined, else the tier picked per app ({} = the suggested ones). */
export function parseAccessAnswer(answer: string | null): Record<string, TierChoice> | null {
  if (!answer || !answer.startsWith('allow')) return null
  if (answer === 'allow') return {}
  try {
    const raw = JSON.parse(answer.slice('allow:'.length)) as Record<string, unknown>
    const out: Record<string, TierChoice> = {}
    for (const [k, v] of Object.entries(raw)) if (v === 'full' || v === 'click' || v === 'view' || v === 'none') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** Files a result card may open with their default app: documents, media, text and data. */
const SAFE_TO_OPEN =
  /\.(md|markdown|txt|log|csv|tsv|json|xml|yaml|yml|toml|ini|html?|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|png|jpe?g|gif|webp|svg|bmp|tiff?|mp3|wav|m4a|flac|ogg|mp4|mov|webm|mkv|zip|7z|tar|gz)$/i


export { parseScheduleArgs, scheduleText } from './tools/routineTools'

/** A routine the app can show and run: a name, a prompt, a schedule of a known kind, and a target object. */
function validRoutine(r: Partial<Routine>): boolean {
  const s = r.schedule as Partial<Schedule> | undefined
  const scheduleOk =
    !!s &&
    ((s.kind === 'once' && Number.isFinite((s as { at?: number }).at)) ||
      (s.kind === 'interval' && Number((s as { minutes?: number }).minutes) > 0) ||
      (s.kind === 'daily' && /^\d{1,2}:\d{2}$/.test(String((s as { time?: string }).time ?? ''))) ||
      (s.kind === 'cron' && typeof (s as { expr?: string }).expr === 'string' && !!(s as { expr?: string }).expr!.trim()))
  return typeof r.name === 'string' && !!r.name.trim() && typeof r.prompt === 'string' && !!r.prompt.trim() &&
    scheduleOk && !!r.target && typeof r.target === 'object' && typeof r.enabled === 'boolean'
}
