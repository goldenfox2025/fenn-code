/**
 * The application service behind window.ancora. Electron-free so it can
 * be driven from tests; main/index.ts only wires it to IPC.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AppEvent, AppSettings, AppSnapshot, Attachment, Conversation, Message, NewChatOptions, Project, Routine, SearchHit, Connector, ConnectorView, AppInfo, UpdateCheck, ProgressItem, ProgressPatch, FolderCandidate } from '../../shared/model'
import type { BackendManager } from '../backends/BackendManager'
import type { Store } from '../store/Store'
import type { ToolDef, ToolServer } from '../tools/ToolServer'
import { nextCron } from './schedule'
import type { BackendPlugin, BackendSummary, HostToolServer } from '../../shared/contract'
import { ProjectFiles } from './ProjectFiles'
import { Artifacts } from './Artifacts'
import { ComputerControl, type ComputerDeps, type TierChoice } from '../computer/ComputerControl'
import { ChatService, textOf } from './ChatService'
import { AutoAssigner } from './AutoAssigner'
import { Orchestrator } from './Orchestrator'
import { ProjectMemory } from './ProjectMemory'
import { Scheduler } from './Scheduler'
import { BACKENDS_EXAMPLE, PREFERRED_BACKENDS } from '../backends/registry'
import { titleFrom } from './titles'
import { applyPatch, removeItem } from './progress'
import { FolderFinder, foldersInText, matchingFolders, rankFolders } from './folders'
import { localeTag, t, tk } from '../../shared/i18n'

/** An unanswered request to control the computer gives up after this long. */
const ASK_TIMEOUT_MS = 3 * 60_000

export class AppCore {
  readonly chat: ChatService
  readonly orchestrator: Orchestrator
  readonly autoAssigner: AutoAssigner
  readonly scheduler: Scheduler
  readonly memory: ProjectMemory
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
    this.memory = new ProjectMemory(store.dir)
    this.files = new ProjectFiles(store.dir)
    this.artifacts = new Artifacts(store.dir)
    this.orchestrator = new Orchestrator(store, this.chat, tools, this.memory, this.files, this.artifacts, backends)
    this.orchestrator.progress = (projectId, patch, by) => this.applyProgress(projectId, patch, by)
    this.orchestrator.onProjectChanged = (project) => this.publish({ type: 'project', project })
    this.orchestrator.extraTools = (conv) => [...this.routineTools(conv), ...(this.computer?.tools(conv) ?? [])]
    this.autoAssigner = new AutoAssigner(store, this.chat, backends)
    this.scheduler = new Scheduler(store, this)
    this.orchestrator.extraServers = () => this.connectorServers()
    if (extras.computer) {
      const computer = new ComputerControl({
        ...extras.computer,
        enabled: () => !!this.store.settings.computerUse,
        seesImages: (id) => {
          const c = this.store.conversation(id)
          return c ? this.backends.acceptsImages(c.backendId) : undefined
        },
        backendName: (id) => {
          const c = this.store.conversation(id)
          return this.backends.list().find((b) => b.id === c?.backendId)?.name ?? t('当前后端')
        },
        askAccess: async (conversationId, req) => {
          const answer = await this.chat.askUser(
            conversationId,
            {
              title: t('允许 agent 操控这些程序？'),
              detail:
                (req.reason ? t('用途：{0}', req.reason) + '\n' : '') +
                t('agent 会看到整个屏幕的截图，但只能在下面允许的程序里点击和输入。操控期间 Ancora 会最小化，屏幕上方有「停止」按钮；闲置 30 分钟后需要重新允许。'),
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
        onUnavailable: (id, message) => void this.chat.notice(id, 'warning', t('电脑操控不可用：{0}', message), 'computer-unavailable')
      })
      this.computer = computer
      this.chat.turnEndListeners.add((id) => computer.turnEnded(id))
    }
    this.repairBackends()
    const orchestrate = this.chat.hooks.afterTurn
    this.chat.hooks.afterTurn = (conv, reply, result) => {
      orchestrate?.(conv, reply, result)
      void this.autoAssigner.consider(conv, reply)
    }
  }

  snapshot(): AppSnapshot {
    return {
      projects: this.store.projects,
      conversations: this.store.conversations,
      routines: this.store.routines,
      settings: this.store.settings,
      backends: this.backends.list(),
      platform: this.platform
    }
  }

  messages(conversationId: string) {
    return this.store.messagesOf(conversationId)
  }

  // ---- chats --------------------------------------------------------------

  resolveBackend(preferred?: string): string {
    if (preferred && this.backends.has(preferred)) return preferred
    const def = this.store.settings.defaultBackendId
    return this.backends.has(def) ? def : this.backends.list()[0].id
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
  repairBackends(): void {
    const list = this.backends.list()
    if (!list.length) return
    // While backends.json is broken its backends only look missing: leave their chats alone
    // until the file is fixed. Only the retired demo agent is gone for good.
    const gone = (id: string) => !this.backends.has(id) && (!this.backendsConfigError || id === 'mock')
    if (gone(this.store.settings.defaultBackendId)) {
      const next = PREFERRED_BACKENDS.find((id) => this.backends.has(id)) ?? list[0].id
      this.publish({ type: 'settings', settings: this.store.patchSettings({ defaultBackendId: next }) })
    }
    const def = this.store.settings.defaultBackendId
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
    const project = this.store.project(opts.projectId)
    const conv = this.chat.createConversation({
      kind: 'chat',
      title: titleFrom(opts.text || opts.attachments?.[0]?.name || ''),
      projectId: project?.id,
      backendId: this.resolveBackend(opts.backendId ?? project?.backendId),
      cwd: opts.cwd === undefined ? project?.cwd || undefined : opts.cwd || undefined,
      modelId: opts.modelId,
      optionValues: opts.optionValues && Object.keys(opts.optionValues).length ? { ...opts.optionValues } : undefined
    })
    if (opts.cwd) this.rememberFolder(opts.cwd)
    void this.chat.send(conv.id, opts.text, { attachments: opts.attachments })
    return conv
  }

  send(conversationId: string, text: string, attachments?: Attachment[]): Promise<void> {
    const conv = this.store.conversation(conversationId)
    // Writing in a resolved thread reopens it, as in Claude Projects.
    if (conv?.resolved) this.chat.patchConversation(conversationId, { resolved: false })
    void this.chat.send(conversationId, text, { attachments })
    return Promise.resolve()
  }

  async regenerate(conversationId: string): Promise<void> {
    const list = this.store.messagesOf(conversationId)
    const lastUser = [...list].reverse().find((m) => m.role === 'user' && !m.hidden)
    if (!lastUser) return
    const { text, attachments } = splitUserMessage(lastUser)
    const variant = await this.chat.rewind(conversationId, lastUser.id)
    void this.chat.send(conversationId, text, { attachments, variant })
  }

  async editMessage(conversationId: string, messageId: string, text: string): Promise<void> {
    const m = this.store.message(conversationId, messageId)
    if (!m || m.role !== 'user') return
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

  /** The stop control shown while an agent controls the computer: withdraw the grant and stop the turn. */
  stopComputer(conversationId: string) {
    this.computer?.revoke(conversationId)
    return this.chat.cancel(conversationId)
  }

  setModel(conversationId: string, modelId: string) {
    return this.chat.setModel(conversationId, modelId)
  }

  async setOption(conversationId: string, optionId: string, value: string): Promise<void> {
    await this.chat.setOption(conversationId, optionId, value)
  }

  async setOptionDefault(backendId: string, optionId: string, value: string): Promise<void> {
    const all = this.store.settings.backendOptionDefaults ?? {}
    this.publish({ type: 'settings', settings: this.store.patchSettings({ backendOptionDefaults: { ...all, [backendId]: { ...all[backendId], [optionId]: value } } }) })
  }

  backendAccount(backendId: string) {
    return this.backends.account(backendId)
  }

  /** Set by the Electron shell: open a file with its default app, or show it in its folder. */
  shellOpen?: (path: string, reveal: boolean) => Promise<string | undefined>

  async openOutput(path: string, reveal = false): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(path)) return { ok: false, error: t('文件已不在原来的位置。') }
    // Programs and scripts are only ever shown in their folder, never run from a card.
    const opens = !reveal && SAFE_TO_OPEN.test(path)
    const err = await this.shellOpen?.(path, !opens)
    return err ? { ok: false, error: err } : { ok: true }
  }

  backendImages(): Record<string, boolean | undefined> {
    return Object.fromEntries(this.backends.list().map((b) => [b.id, b.images]))
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

  async updateConversation(id: string, patch: Partial<Conversation>): Promise<void> {
    const before = this.store.conversation(id)
    // A title the user typed is theirs; the app stops improving it.
    if ('title' in patch) patch = { ...patch, titleAuto: false }
    this.chat.patchConversation(id, patch)
    // A session is tied to its folder: the next turn starts a new one there, with the conversation so far.
    if ('cwd' in patch && before && (before.cwd || undefined) !== (patch.cwd || undefined)) this.chat.forgetSession(id)
    if ('cwd' in patch) this.rememberFolder(patch.cwd)
  }

  async deleteConversation(id: string): Promise<void> {
    await this.chat.cancel(id).catch(() => {})
    this.chat.forgetSession(id)
    // Deleting a thread also removes its card from the project chat.
    for (const c of this.store.conversations.filter((c) => c.anchorMessageId && c.id === id)) {
      const proj = this.store.project(c.projectId)
      if (proj) {
        for (const m of this.store.messagesOf(proj.conversationId)) {
          const before = m.blocks.length
          m.blocks = m.blocks.filter((b) => !(b.type === 'thread-card' && b.threadId === id))
          if (m.blocks.length !== before) this.chat.updateMessage(m)
        }
      }
    }
    this.tools.revoke(id)
    this.computer?.forget(id)
    this.store.removeConversation(id)
    this.publish({ type: 'conversation-removed', id })
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
    await this.send(conversationId, t('关于「{0}」，我选：{1}', b.question, b.options[option].label))
  }

  // ---- projects -----------------------------------------------------------

  async createProject(p: { name: string; description?: string; instructions?: string; cwd?: string; backendId?: string }): Promise<Project> {
    const now = Date.now()
    const id = randomUUID()
    const backendId = this.resolveBackend(p.backendId)
    this.rememberFolder(p.cwd)
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
    const next = { ...p, ...patch, updatedAt: Date.now() }
    this.store.putProject(next)
    this.publish({ type: 'project', project: next })
    if (patch.name) this.chat.patchConversation(p.conversationId, { title: patch.name })
    if ('archived' in patch && !!patch.archived !== !!p.archived) this.pauseRoutinesFor(id, !!patch.archived)
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
    if (!dir) return
    const list = this.store.settings.recentFolders ?? []
    if (list[0] === dir) return
    const next = [dir, ...list.filter((f) => f !== dir)].slice(0, 12)
    this.publish({ type: 'settings', settings: this.store.patchSettings({ recentFolders: next }) })
  }

  // ---- progress board -------------------------------------------------------

  private applyProgress(projectId: string, patch: ProgressPatch, by: 'user' | 'agent' | 'app'): ProgressItem {
    const p = this.store.project(projectId)
    if (!p) throw new Error(t('项目不存在'))
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
      else await this.deleteConversation(c.id)
    }
    this.store.removeProject(id)
    this.publish({ type: 'project-removed', id })
  }

  // ---- routines (scheduler lives elsewhere; this is CRUD) ---------------------

  async saveRoutine(r: Omit<Routine, 'id' | 'createdAt'> & { id?: string }): Promise<Routine> {
    const prev = r.id ? this.store.routines.find((x) => x.id === r.id) : undefined
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

  /**
   * Agents can set up recurring work themselves (like Claude's routines): a
   * prompt that runs on a schedule and posts into this conversation, the
   * project chat, or a new chat each time.
   */
  private routineTools(conv: Conversation): ToolDef[] {
    const mine = (r: Routine) =>
      r.target.conversationId === conv.id || (!!conv.projectId && r.target.projectId === conv.projectId) || r.createdBy === conv.id
    const line = (r: Routine) =>
      `${r.id.slice(0, 8)}  「${r.name}」 ${scheduleText(r.schedule)}${r.enabled ? '' : '（已暂停）'}${r.nextRunAt ? `，下次 ${new Date(r.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`
    return [
      {
        name: 'create_routine',
        description:
          '建一个定时任务：到点时把 prompt 作为一条消息发给 agent 执行（无人值守，不能操控电脑，也不能等用户批准）。适合需要反复做的事（每天汇总、定期检查）或稍后提醒。用户能在「定时任务」页看到、暂停和删除。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '几个词的名字' },
            prompt: { type: 'string', description: '每次运行时交给 agent 的完整指令' },
            schedule: { type: 'string', enum: ['once', 'interval', 'daily', 'weekly', 'cron'] },
            at: { type: 'string', description: 'once：运行时间，ISO 8601，例如 2026-10-16T09:00:00+08:00' },
            minutes: { type: 'integer', description: 'interval：间隔分钟数（至少 5）' },
            time: { type: 'string', description: 'daily / weekly：本地时间 HH:MM' },
            weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly：星期几，0=周日 … 6=周六' },
            cron: { type: 'string', description: 'cron：五段式表达式' },
            post_to: { type: 'string', enum: ['here', 'new_chat'], description: 'here（默认）：结果发在这个对话或项目里；new_chat：每次新建一个对话' }
          },
          required: ['name', 'prompt', 'schedule']
        },
        aliases: { prompt: ['instructions', 'task', 'message'], name: ['title'] },
        run: async (a) => {
          // A routine that sets up routines could multiply without anyone watching.
          if (this.chat.isUnattended(conv.id))
            throw new Error('这是定时任务的无人值守运行，不能再建定时任务。需要的话，请在结果里建议用户自己建。')
          if (this.store.routines.filter((r) => r.createdBy === conv.id).length >= 10)
            throw new Error('这个对话已经建了 10 个定时任务，不能再建。请先用 delete_routine 删掉不需要的。')
          const name = String(a.name ?? '').trim().slice(0, 60)
          const prompt = String(a.prompt ?? '').trim()
          if (!name || !prompt) throw new Error('name 和 prompt 都不能为空')
          const schedule = parseScheduleArgs(a)
          const target =
            a.post_to === 'new_chat' ? {} : conv.kind === 'project' && conv.projectId ? { projectId: conv.projectId } : { conversationId: conv.id }
          const r = await this.saveRoutine({ name, prompt, schedule, target, backendId: conv.backendId, enabled: true, createdBy: conv.id })
          this.chat.notice(conv.id, 'info', t('已创建定时任务「{0}」：{1}', r.name, scheduleText(r.schedule)), `routine-${r.id}`)
          return `已创建：${line(r)}`
        }
      },
      {
        name: 'list_routines',
        description: '列出和这个对话或项目有关的定时任务。',
        inputSchema: { type: 'object', properties: {}, required: [] },
        run: () => this.store.routines.filter(mine).map(line).join('\n') || '没有定时任务。'
      },
      {
        name: 'delete_routine',
        description: '删除一个定时任务（只限和这个对话或项目有关的）。id 用 list_routines 给出的前 8 位即可。',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async (a) => {
          const id = String(a.id ?? '').trim()
          const r = this.store.routines.find((x) => mine(x) && (x.id === id || (id.length >= 6 && x.id.startsWith(id))))
          if (!r) throw new Error('没有这个定时任务（或它不属于这个对话）')
          await this.deleteRoutine(r.id)
          this.chat.notice(conv.id, 'info', t('已删除定时任务「{0}」', r.name), `routine-${r.id}`)
          return `已删除「${r.name}」。`
        }
      }
    ]
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
    this.store.removeRoutine(id)
    this.publish({ type: 'routine-removed', id })
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
    if (name.toLowerCase() === 'ancora') throw new Error(t('ancora 是应用自己的工具名，请换一个名称'))
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

  async backendLogin(backendId: string, methodId: string): Promise<void> {
    await this.backends.authenticate(backendId, methodId)
    // Sessions created before signing in may be unusable; start fresh.
    for (const c of this.store.conversations) if (c.backendId === backendId) this.chat.forgetSession(c.id)
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

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    const settings = this.store.patchSettings(patch)
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
        await this.backends.setPlugins(this.reloadPlugins())
        this.backendsConfigError = undefined
      } catch (e) {
        this.backendsConfigError = e instanceof Error ? e.message : String(e)
      }
    }
    this.repairBackends()
    const list = this.backends.list()
    this.publish({ type: 'backends', backends: list })
    return { backends: list, error: this.backendsConfigError }
  }

  /** Filled in by the Electron entry point (version, commit, runtime versions). */
  info: AppInfo = { name: 'Ancora', version: '0.0.0', platform: process.platform, arch: process.arch }
  /**
   * Where to look for a newer version: a JSON document like
   * {"version":"0.2.0","url":"https://…","notes":"…"}. Unset until the app has a release channel.
   */
  updateFeed?: string
  fetchJson: (url: string) => Promise<unknown> = async (url) => (await fetch(url)).json()

  async convertToThread(conversationId: string, messageId: string): Promise<void> {
    this.orchestrator.convertToThread(conversationId, messageId)
  }

  appInfo(): AppInfo {
    return this.info
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

/** The schedule a create_routine call describes. */
export function parseScheduleArgs(a: Record<string, unknown>, now = Date.now()): Routine['schedule'] {
  switch (String(a.schedule ?? '')) {
    case 'once': {
      const at = Date.parse(String(a.at ?? ''))
      if (!Number.isFinite(at)) throw new Error('once 需要 at（ISO 8601 时间）')
      if (at < now - 60_000) throw new Error('at 已经过去了')
      return { kind: 'once', at }
    }
    case 'interval': {
      const minutes = Math.round(Number(a.minutes))
      if (!Number.isFinite(minutes) || minutes < 5) throw new Error('interval 需要 minutes，至少 5')
      return { kind: 'interval', minutes }
    }
    case 'daily':
    case 'weekly': {
      const time = String(a.time ?? '').trim()
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('需要 time，格式 HH:MM')
      const hhmm = time.padStart(5, '0')
      if (a.schedule === 'daily') return { kind: 'daily', time: hhmm }
      const days = (Array.isArray(a.weekdays) ? a.weekdays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      if (!days.length) throw new Error('weekly 需要 weekdays，例如 [1, 3, 5]')
      return { kind: 'daily', time: hhmm, weekdays: [...new Set(days)].sort() }
    }
    case 'cron': {
      const expr = String(a.cron ?? '').trim()
      if (nextCron(expr, now) === undefined) throw new Error('cron 表达式无效')
      return { kind: 'cron', expr }
    }
    default:
      throw new Error('schedule 只能是 once、interval、daily、weekly、cron')
  }
}

const WEEKDAYS = [tk('周日'), tk('周一'), tk('周二'), tk('周三'), tk('周四'), tk('周五'), tk('周六')]
export function scheduleText(s: Routine['schedule']): string {
  switch (s.kind) {
    case 'once':
      return t('一次，{0}', new Date(s.at).toLocaleString(localeTag(), { hour12: false }))
    case 'interval':
      return s.minutes % 60 === 0 ? t('每 {0} 小时', s.minutes / 60) : t('每 {0} 分钟', s.minutes)
    case 'daily':
      return s.weekdays?.length && s.weekdays.length < 7
        ? t('每{0} {1}', s.weekdays.map((d) => t(WEEKDAYS[d])).join(t('、')), s.time)
        : t('每天 {0}', s.time)
    case 'cron':
      return `cron ${s.expr}`
  }
}
