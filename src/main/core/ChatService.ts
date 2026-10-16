/**
 * Runs conversations: binds each conversation to a backend session, queues
 * turns, folds streamed AgentEvents into persisted messages, and publishes
 * AppEvents. It talks to agents only through BackendManager (the contract).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, Cost, HostToolServer, ModelInfo, PermissionRequest, SessionInfo, SessionOption, TurnResult } from '../../shared/contract'
import type { PromptPart } from '../../shared/contract'
import type { AppEvent, Attachment, Block, Conversation, Message } from '../../shared/model'
import { addTurn, emptyTotals, estimateTokens, type MessageUsage } from '../../shared/usage'
import type { BackendManager } from '../backends/BackendManager'
import type { Store } from '../store/Store'
import { t } from '../../shared/i18n'
import { TurnMeter } from './TurnMeter'
import { sessionOptionDefaults } from '../../shared/sessionOptions'

export interface SendOptions {
  attachments?: Attachment[]
  /** The agent's reply to this turn is housekeeping and stays out of the transcript. */
  hiddenReply?: boolean
  /** Start a new agent session after this turn (context handoff). */
  rotateAfter?: boolean
  /** Both sides of this turn are app bookkeeping; see Message.housekeeping. */
  housekeeping?: boolean
  /** Nobody is watching (e.g. a scheduled task): prompts for the user fail fast. */
  unattended?: boolean
  /** Not shown in the transcript (e.g. a relayed note or system nudge). */
  hidden?: boolean
  role?: 'user' | 'system'
  /** The new version of an edited or regenerated turn. */
  variant?: Message['variant']
}

export interface TurnHooks {
  /** Text placed before the first prompt of a fresh session (instructions, history). */
  preamble?(conv: Conversation, isResume: boolean): string
  /** MCP-style tool server the agent session may use. */
  tools?(conv: Conversation): HostToolServer[]
  /**
   * Context for a fresh session of a conversation that already has history.
   * Defaults to replaying the transcript.
   */
  history?(conv: Conversation, prior: Message[]): string | undefined
  /** Text placed before every prompt (e.g. updates that happened since the last turn). */
  beforePrompt?(conv: Conversation): string
  /** Called after each turn finishes. */
  afterTurn?(conv: Conversation, reply: Message, result: TurnResult): void
}

interface Live {
  sessionId: string
  backendId: string
  /** Turns and characters exchanged in this session, for deciding when to hand off. */
  turns: number
  chars: number
  /** The app's token estimate of what the session holds, for agents that report no usage. */
  estTokens: number
  /** The session's cumulative cost as the backend last reported it (ACP usage_update). */
  cost?: Cost
}

interface QueuedTurn {
  text: string
  opts: SendOptions
  resolve: () => void
}

export class ChatService {
  private live = new Map<string, Live>() // conversationId → session
  private bySession = new Map<string, string>() // `${backend}:${session}` → conversationId
  private current = new Map<string, Message>() // conversationId → streaming reply
  private meters = new Map<string, TurnMeter>()
  private queues = new Map<string, QueuedTurn[]>()
  private running = new Set<string>()
  private unattendedTurns = new Set<string>()
  /** Called after every turn, visible or not, once the conversation is free again. */
  readonly turnEndListeners = new Set<(conversationId: string) => void>()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private pendingPermissions = new Map<string, string>() // requestId → conversationId
  private hostWaiters = new Map<string, (d: string | null) => void>()
  hooks: TurnHooks = {}

  constructor(
    private readonly store: Store,
    private readonly backends: BackendManager,
    private readonly publish: (e: AppEvent) => void
  ) {
    backends.onAgentEvent((backendId, sessionId, event) => this.onAgentEvent(backendId, sessionId, event))
    backends.onSessionsLost((backendId) => {
      for (const [convId, live] of this.live) if (live.backendId === backendId) this.forgetSession(convId)
    })
  }

  // ---- conversations ------------------------------------------------------

  createConversation(init: Partial<Conversation> & Pick<Conversation, 'kind' | 'title' | 'backendId'>): Conversation {
    const now = Date.now()
    const conv: Conversation = { id: randomUUID(), createdAt: now, updatedAt: now, status: 'idle', ...init,
      modelId: init.modelId ?? this.store.settings.backendModelDefaults?.[init.backendId] }
    this.saveConversation(conv)
    return conv
  }

  saveConversation(conv: Conversation): void {
    this.store.putConversation(conv)
    this.publish({ type: 'conversation', conversation: conv })
  }

  patchConversation(id: string, patch: Partial<Conversation>): Conversation | undefined {
    const conv = this.store.conversation(id)
    if (!conv) return undefined
    const next = { ...conv, ...patch }
    this.saveConversation(next)
    return next
  }

  addMessage(conversationId: string, role: Message['role'], blocks: Block[], extra: Partial<Message> = {}): Message {
    const m: Message = { id: randomUUID(), conversationId, role, blocks, createdAt: Date.now(), state: 'done', ...extra }
    this.store.putMessage(m)
    this.publish({ type: 'message', message: m })
    this.recount(conversationId)
    return m
  }

  private recount(conversationId: string): void {
    const n = this.store.messagesOf(conversationId).filter((m) => !m.hidden).length
    const conv = this.store.conversation(conversationId)
    if (conv && conv.messageCount !== n) this.saveConversation({ ...conv, messageCount: n })
  }

  updateMessage(m: Message): void {
    this.store.putMessage(m)
    this.publish({ type: 'message', message: m })
  }

  /** The reply currently streaming in a conversation, if any. */
  currentReply(conversationId: string): Message | undefined {
    return this.current.get(conversationId)
  }

  /** True while a turn nobody is watching (e.g. a scheduled task) runs. */
  isUnattended(conversationId: string): boolean {
    return this.unattendedTurns.has(conversationId)
  }

  isBusy(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  // ---- turns --------------------------------------------------------------

  /** Queues a user turn; resolves when that turn has finished. */
  send(conversationId: string, text: string, opts: SendOptions = {}): Promise<void> {
    return new Promise((resolve) => {
      const q = this.queues.get(conversationId) ?? []
      q.push({ text, opts, resolve })
      this.queues.set(conversationId, q)
      void this.pump(conversationId)
    })
  }

  private async pump(conversationId: string): Promise<void> {
    if (this.running.has(conversationId)) return
    const q = this.queues.get(conversationId)
    const next = q?.shift()
    if (!next) return
    this.running.add(conversationId)
    if (next.opts.unattended) this.unattendedTurns.add(conversationId)
    try {
      await this.runTurn(conversationId, next.text, next.opts)
    } finally {
      this.running.delete(conversationId)
      this.unattendedTurns.delete(conversationId)
      for (const fn of this.turnEndListeners) fn(conversationId)
      next.resolve()
      void this.pump(conversationId)
    }
  }

  private async runTurn(conversationId: string, text: string, opts: SendOptions): Promise<void> {
    let conv = this.store.conversation(conversationId)
    if (!conv) return
    const prior = this.store.messagesOf(conversationId).filter((m) => m.state !== 'streaming')
    const attachments = opts.attachments ?? []
    this.addMessage(
      conversationId,
      opts.role ?? 'user',
      [...attachments.map((a): Block => ({ type: 'attachment', attachment: a })), ...(text ? [{ type: 'text' as const, text }] : [])],
      { hidden: opts.hidden, housekeeping: opts.housekeeping || undefined, variant: opts.variant }
    )

    const reply: Message = {
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      blocks: [],
      createdAt: Date.now(),
      state: 'streaming',
      hidden: opts.hiddenReply || undefined,
      housekeeping: opts.housekeeping || undefined
    }
    this.current.set(conversationId, reply)
    this.updateMessage(reply)
    this.recount(conversationId)
    conv = this.patchConversation(conversationId, { status: 'working', updatedAt: Date.now() })!

    let result: TurnResult
    let live: Live | undefined
    let costAtStart: Cost | undefined
    // Starting an agent can be slow (the first launch may download it); say so instead of looking stuck.
    const slow = setTimeout(() => {
      const name = this.backends.list().find((b) => b.id === conv!.backendId)?.name ?? 'agent'
      applyEvent(reply.blocks, { kind: 'notice', level: 'info', key: 'starting', text: t('正在启动 {0}……', name) })
      this.scheduleEmit(reply)
    }, 5000)
    try {
      const session = await this.ensureSession(conv).finally(() => {
        clearTimeout(slow)
        const i = reply.blocks.findIndex((b) => b.type === 'notice' && b.key === 'starting')
        if (i >= 0) {
          reply.blocks.splice(i, 1)
          this.scheduleEmit(reply)
        }
      })
      live = session.live
      let promptText = text
      const updates = this.hooks.beforePrompt?.(conv) ?? ''
      if (session.fresh) {
        const pre = this.hooks.preamble?.(conv, prior.length > 0) ?? ''
        const history = prior.length ? (this.hooks.history?.(conv, prior) ?? transcript(prior)) : ''
        promptText = [pre, history, updates, history ? `新消息：\n${text}` : text].filter(Boolean).join('\n\n')
      } else if (updates) {
        promptText = `${updates}\n\n${text}`
      }
      const parts: PromptPart[] = [{ type: 'text', text: promptText }, ...attachments.map(toPart)]
      live.turns++
      live.chars += promptText.length
      live.estTokens += estimateTokens(promptText) + attachments.reduce((n, a) => n + estimateTokens(a.text ?? ''), 0)
      costAtStart = live.cost
      this.meters.set(conversationId, new TurnMeter(performance.now()))
      result = await this.backends.prompt(live.backendId, live.sessionId, parts)
    } catch (err) {
      result = { stopReason: 'error', error: err instanceof Error ? err.message : String(err) }
    }

    this.flushEmit(reply)
    this.current.delete(conversationId)
    reply.state = result.stopReason === 'error' ? 'error' : result.stopReason === 'cancelled' ? 'cancelled' : 'done'
    if (result.error) reply.error = result.error
    let usage = turnUsageOf(result, costAtStart, live?.cost)
    // No token counts from the agent: count what went back and forth, and say it is an estimate.
    const reported = usage && (usage.input !== undefined || usage.output !== undefined || usage.total !== undefined)
    const produced = estimateReply(reply)
    if (live) live.estTokens += produced.output + produced.tools
    if (!reported && live && result.stopReason !== 'error' && (produced.output || produced.tools)) {
      const input = live.estTokens - produced.output
      usage = { ...usage, input, output: produced.output, total: input + produced.output, estimated: true }
    }
    if (usage) reply.usage = usage
    reply.timing = this.meters.get(conversationId)?.finish(result.usage, result.stopReason,
      !this.backends.list().find((b) => b.id === conv!.backendId)?.credits)
    this.meters.delete(conversationId)
    this.updateMessage(reply)
    // A turn that failed before the agent answered says nothing about what the backend reports.
    if (usage || (live && result.stopReason !== 'error')) {
      const c = this.store.conversation(conversationId)
      if (c) this.patchConversation(conversationId, { usage: { ...addTurn(c.usage, usage), contextUsed: c.usage?.contextUsed, contextSize: c.usage?.contextSize, contextEstimate: live?.estTokens ?? c.usage?.contextEstimate } })
    }

    if (live) live.chars += JSON.stringify(reply.blocks).length
    // If the save-memory turn failed, keep the session: rotating now would lose what it didn't save.
    if (opts.rotateAfter && result.stopReason !== 'error') this.rotate(conversationId)

    const preview = plainPreview(textOf(reply))
    const after = this.patchConversation(conversationId, {
      status: result.stopReason === 'error' ? 'error' : 'idle',
      ...(opts.hiddenReply ? {} : { updatedAt: Date.now(), lastPreview: preview || this.store.conversation(conversationId)?.lastPreview, unread: true,
        ...(!opts.housekeeping ? { timing: reply.timing } : {}) })
    })
    // The conversation may have been deleted while the reply ran.
    if (after && !opts.hiddenReply) this.hooks.afterTurn?.(after, reply, result)
  }

  /** How much the current agent session of a conversation has seen. */
  sessionLoad(conversationId: string): { turns: number; chars: number } | undefined {
    const l = this.live.get(conversationId)
    return l && { turns: l.turns, chars: l.chars }
  }

  /** Ends the current agent session; the next turn starts fresh with a handoff. */
  /** The user's working folder for a conversation: its own, or its project's. */
  folderOf(conv: Conversation): string | undefined {
    return conv.cwd || this.store.project(conv.projectId)?.cwd || undefined
  }

  private scratchDir(conversationId: string): string {
    const dir = join(this.store.dir, 'workspaces', conversationId.replace(/[^a-zA-Z0-9-]/g, ''))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  rotate(conversationId: string): void {
    this.forgetSession(conversationId)
    this.patchConversation(conversationId, { sessionRef: undefined })
  }

  private async ensureSession(conv: Conversation): Promise<{ live: Live; fresh: boolean }> {
    const existing = this.live.get(conv.id)
    if (existing && existing.backendId === conv.backendId) return { live: existing, fresh: false }
    // With a working folder the agent works there; without one it gets a private, empty
    // folder of its own, so it never lands in the user's home by default.
    const folder = this.folderOf(conv)
    const opts = { cwd: folder ?? this.scratchDir(conv.id), folder, tools: this.hooks.tools?.(conv) }

    // After a restart, reattach to the agent's own session when the backend can.
    let info: SessionInfo | null = null
    let fresh = true
    if (conv.sessionRef?.backendId === conv.backendId) {
      info = await this.backends.resumeSession(conv.backendId, conv.sessionRef.sessionId, opts).catch(() => null)
      fresh = !info
    }
    info ??= await this.backends.newSession(conv.backendId, opts)

    const live: Live = { sessionId: info.sessionId, backendId: conv.backendId, turns: 0, chars: 0, estTokens: 0 }
    this.live.set(conv.id, live)
    this.bySession.set(`${conv.backendId}:${info.sessionId}`, conv.id)
    // A new session's offered options replace the previous session's capabilities.
    this.patchConversation(conv.id, { sessionOptions: info.options ?? [] })
    let modelId = info.currentModelId
    if (conv.modelId && conv.modelId !== info.currentModelId && info.models?.some((m) => m.id === conv.modelId)) {
      try { await this.backends.setModel(conv.backendId, info.sessionId, conv.modelId) }
      catch (error) { this.forgetSession(conv.id); throw error }
      modelId = conv.modelId
    }
    // The conversation's own choices win; a new conversation starts with the backend's defaults.
    let options = this.store.conversation(conv.id)?.sessionOptions ?? info.options
    // A mode is never a default for new chats (an earlier version could save one); other choices are.
    const defaults = sessionOptionDefaults(this.store.settings, conv.backendId, modelId ?? conv.modelId)
    for (const o of options ?? []) {
      const v = conv.optionValues?.[o.id] ?? (o.category === 'mode' ? undefined : defaults[o.id])
      if (!v || v === o.current || !o.choices.some((c) => c.value === v)) continue
      try {
        options = (await this.backends.setOption(conv.backendId, info.sessionId, o.id, v)) ?? options?.map((x) => (x.id === o.id ? { ...x, current: v } : x))
      } catch (error) { this.forgetSession(conv.id); throw error }
    }
    this.patchConversation(conv.id, {
      models: info.models ?? conv.models,
      modelId: modelId ?? conv.modelId,
      sessionOptions: options ?? [],
      sessionRef: live
    })
    // A mode belongs to this conversation; new chats start in the agent's own mode.
    const offered = options?.map((o) => (o.category === 'mode' ? { ...o, current: info.options?.find((x) => x.id === o.id)?.current ?? o.current } : o))
    if (info.models?.length) this.rememberModels(conv.backendId, info.models, modelId, offered)
    return { live, fresh }
  }

  /** Keeps the backend's model list (and its default) for new chats; publishes only when it changed. */
  rememberModels(backendId: string, models: ModelInfo[], current?: string, options?: SessionOption[]): void {
    const all = this.store.settings.backendModels ?? {}
    const next = { models: models.map((m) => ({ ...m })), current, ...(options?.length ? { options } : {}) }
    if (JSON.stringify(all[backendId]) === JSON.stringify(next)) return
    this.publish({ type: 'settings', settings: this.store.patchSettings({ backendModels: { ...all, [backendId]: next } }) })
  }

  async cancel(conversationId: string): Promise<void> {
    this.queues.set(conversationId, [])
    const live = this.live.get(conversationId)
    if (live && this.running.has(conversationId)) await this.backends.cancel(live.backendId, live.sessionId)
    // Dismiss any permission prompt this turn is waiting on.
    for (const [rid, cid] of this.pendingPermissions) if (cid === conversationId) this.respondPermission(rid, null)
  }

  async setModel(conversationId: string, modelId: string): Promise<void> {
    const live = this.live.get(conversationId)
    if (live) await this.backends.setModel(live.backendId, live.sessionId, modelId)
    this.patchConversation(conversationId, { modelId })
    const conv = this.store.conversation(conversationId)
    if (conv) {
      const defaults = sessionOptionDefaults(this.store.settings, conv.backendId, modelId)
      for (const option of conv.sessionOptions ?? []) {
        const value = defaults[option.id] ?? conv.optionValues?.[option.id]
        if (option.category !== 'mode' && value && option.choices.some((c) => c.value === value)) {
          if (value !== option.current) await this.setOption(conversationId, option.id, value)
          else if (conv.optionValues?.[option.id] !== value) this.patchConversation(conversationId, {
            optionValues: { ...this.store.conversation(conversationId)?.optionValues, [option.id]: value }
          })
        }
      }
    }
  }

  async setOption(conversationId: string, optionId: string, value: string): Promise<void> {
    const conv = this.store.conversation(conversationId)
    if (!conv) return
    const live = this.live.get(conversationId)
    let options = conv.sessionOptions?.map((o) => (o.id === optionId ? { ...o, current: value } : o))
    if (live) options = (await this.backends.setOption(live.backendId, live.sessionId, optionId, value)) ?? options
    this.patchConversation(conversationId, { sessionOptions: options, optionValues: { ...conv.optionValues, [optionId]: value } })
  }

  /**
   * Sets aside a message and everything after it as an older version of that
   * turn, and starts a new agent session (the old one remembers the removed
   * turns). The next turn replays the rest. Returns the new version's info.
   */
  async rewind(conversationId: string, fromMessageId: string): Promise<Message['variant']> {
    await this.stopTurn(conversationId)
    const { removed, variant } = this.store.archiveFrom(conversationId, fromMessageId)
    for (const m of removed) this.publish({ type: 'message-removed', conversationId, id: m.id })
    this.restartSession(conversationId)
    return variant
  }

  /** Shows another version of an edited or regenerated turn; the next turn continues from it. */
  async switchVariant(conversationId: string, group: string, index: number): Promise<void> {
    await this.stopTurn(conversationId)
    const r = this.store.switchVariant(conversationId, group, index)
    if (!r) return
    for (const m of r.removed) this.publish({ type: 'message-removed', conversationId, id: m.id })
    for (const m of r.restored) this.publish({ type: 'message', message: m })
    this.restartSession(conversationId)
  }

  private async stopTurn(conversationId: string) {
    if (this.running.has(conversationId)) await this.cancel(conversationId)
    await until(() => !this.running.has(conversationId))
  }
  /** The agent's session remembers the turns now off screen: start fresh, replaying what is shown. */
  private restartSession(conversationId: string) {
    this.forgetSession(conversationId)
    this.patchConversation(conversationId, { sessionRef: undefined })
    this.recount(conversationId)
  }

  /** Drops the live session so the next turn starts fresh (e.g. after a backend switch). */
  forgetSession(conversationId: string): void {
    const live = this.live.get(conversationId)
    if (live) this.bySession.delete(`${live.backendId}:${live.sessionId}`)
    this.live.delete(conversationId)
  }

  // ---- permissions --------------------------------------------------------

  routePermission(backendId: string, request: PermissionRequest): void {
    const conversationId = this.bySession.get(`${backendId}:${request.sessionId}`)
    if (conversationId) {
      this.meters.get(conversationId)?.interrupt()
      this.pendingPermissions.set(request.requestId, conversationId)
      this.patchConversation(conversationId, { status: 'waiting' })
    }
    this.publish({ type: 'permission', conversationId, request })
  }

  /** A backend dropped a permission prompt on its own (e.g. it crashed). */
  permissionDropped(requestId: string): void {
    this.pendingPermissions.delete(requestId)
    this.publish({ type: 'permission-resolved', requestId })
  }

  /**
   * Asks the user a permission question on behalf of the app itself (not a
   * backend), shown the same way as an agent's permission prompt.
   */
  /** Asks the user something on the app's own behalf; with timeoutMs, an unanswered prompt resolves to null. */
  askUser(
    conversationId: string,
    q: Omit<PermissionRequest, 'requestId' | 'sessionId'>,
    timeoutMs?: number
  ): Promise<string | null> {
    const requestId = 'host-' + randomUUID()
    this.meters.get(conversationId)?.interrupt()
    return new Promise((resolve) => {
      this.hostWaiters.set(requestId, resolve)
      if (timeoutMs) setTimeout(() => this.hostWaiters.has(requestId) && this.respondPermission(requestId, null), timeoutMs)
      this.pendingPermissions.set(requestId, conversationId)
      this.patchConversation(conversationId, { status: 'waiting' })
      this.publish({ type: 'permission', conversationId, request: { ...q, requestId, sessionId: '' } })
    })
  }

  respondPermission(requestId: string, decision: string | null): void {
    const conversationId = this.pendingPermissions.get(requestId)
    this.pendingPermissions.delete(requestId)
    const host = this.hostWaiters.get(requestId)
    this.hostWaiters.delete(requestId)
    if (host) host(decision)
    else this.backends.respondPermission(requestId, decision)
    this.publish({ type: 'permission-resolved', requestId })
    if (conversationId && this.running.has(conversationId)) this.patchConversation(conversationId, { status: 'working' })
  }

  // ---- streaming ----------------------------------------------------------

  private onAgentEvent(backendId: string, sessionId: string, event: AgentEvent): void {
    const conversationId = this.bySession.get(`${backendId}:${sessionId}`)
    if (!conversationId) return
    // The agent changed its own options (e.g. left plan mode): show what is in effect now.
    if (event.kind === 'options') {
      this.patchConversation(conversationId, { sessionOptions: event.options })
      return
    }
    if (event.kind === 'usage') {
      const live = this.live.get(conversationId)
      if (event.cost && live) live.cost = event.cost
      const c = this.store.conversation(conversationId)
      if (c && (event.contextUsed !== undefined || event.contextSize !== undefined))
        this.patchConversation(conversationId, {
          usage: { ...(c.usage ?? emptyTotals()), contextUsed: event.contextUsed ?? c.usage?.contextUsed, contextSize: event.contextSize ?? c.usage?.contextSize }
        })
      return
    }
    const reply = this.current.get(conversationId)
    if (!reply) return
    this.meters.get(conversationId)?.observe(event)
    // The agent's own task plan (ACP `plan`) is the conversation's live plan too.
    if (event.kind === 'plan' && event.entries.length) {
      const conv = this.store.conversation(conversationId)
      if (conv) this.patchConversation(conversationId, { checklist: planChecklist(conv.title, event.entries), checklistAuto: false })
    }
    applyEvent(reply.blocks, event)
    this.scheduleEmit(reply)
  }

  /** Adds an app-side notice to the reply being written in this conversation (e.g. a feature that can't work here). */
  notice(conversationId: string, level: 'info' | 'warning' | 'error', text: string, key?: string): boolean {
    const reply = this.current.get(conversationId)
    if (!reply) return false
    applyEvent(reply.blocks, { kind: 'notice', level, text, key })
    this.scheduleEmit(reply)
    return true
  }

  private scheduleEmit(m: Message): void {
    if (this.emitTimers.has(m.id)) return
    this.emitTimers.set(
      m.id,
      setTimeout(() => {
        this.emitTimers.delete(m.id)
        this.updateMessage(m)
      }, 40)
    )
  }

  private flushEmit(m: Message): void {
    clearTimeout(this.emitTimers.get(m.id))
    this.emitTimers.delete(m.id)
  }
}

/** An ACP plan in the app's checklist format. */
export function planChecklist(title: string, entries: { content: string; status: string }[]): string {
  const mark = (s: string) => (s === 'completed' ? '✓' : s === 'in_progress' ? '✱' : '○')
  return [title, '', ...entries.map((e) => `${mark(e.status)} ${e.content.replace(/\s+/g, ' ').trim()}`)].join('\n')
}

export function applyEvent(blocks: Block[], e: AgentEvent, now = Date.now()): void {
  const last = blocks[blocks.length - 1]
  // Thinking ends when anything else arrives.
  if (last?.type === 'thought' && last.startedAt && e.kind !== 'thought.delta') last.ms = now - last.startedAt
  switch (e.kind) {
    case 'message.delta':
      if (last?.type === 'text') last.text += e.text
      else blocks.push({ type: 'text', text: e.text })
      break
    case 'thought.delta':
      if (last?.type === 'thought') {
        last.text += e.text
        if (last.startedAt) last.ms = now - last.startedAt
      } else blocks.push({ type: 'thought', text: e.text, startedAt: now, ms: 0 })
      break
    case 'tool.start':
      blocks.push({ type: 'tool', toolId: e.toolId, title: e.title, toolKind: e.toolKind, status: e.status, input: e.input })
      break
    case 'tool.update': {
      const t = blocks.find((b): b is Extract<Block, { type: 'tool' }> => b.type === 'tool' && b.toolId === e.toolId)
      if (!t) break
      if (e.title) t.title = e.title
      if (e.status) t.status = e.status
      if (e.output != null) t.output = e.output
      break
    }
    case 'plan': {
      const i = blocks.findIndex((b) => b.type === 'plan')
      const plan: Block = { type: 'plan', entries: e.entries }
      if (i >= 0) blocks[i] = plan
      else blocks.push(plan)
      break
    }
    case 'notice': {
      const block: Block = { type: 'notice', level: e.level, text: e.text, key: e.key }
      const i = e.key ? blocks.findIndex((b) => b.type === 'notice' && b.key === e.key) : -1
      if (i >= 0) blocks[i] = block
      else blocks.push(block)
      break
    }
  }
}

function toPart(a: Attachment): PromptPart {
  return a.kind === 'image'
    ? { type: 'image', mimeType: a.mimeType, data: a.data ?? '', name: a.name }
    : { type: 'file', name: a.name, mimeType: a.mimeType, text: a.text ?? '', path: a.path }
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!fn() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 30))
}

/** One line of plain text for lists: markdown marks, code fences and links reduced to their words. */
export function plainPreview(md: string, max = 140): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[，。！？,.!?])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** Estimated tokens a reply generated (text, thinking, tool calls) and tool results it read back in. */
export function estimateReply(m: Message): { output: number; tools: number } {
  let output = 0
  let tools = 0
  for (const b of m.blocks) {
    if (b.type === 'text' || b.type === 'thought') output += estimateTokens(b.text)
    else if (b.type === 'tool') {
      output += estimateTokens(b.input ?? '') + estimateTokens(b.title)
      tools += estimateTokens(b.output ?? '')
    }
  }
  return { output, tools }
}

export function textOf(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

export type Line = { who: '用户' | '助手' | '（内部消息）'; text: string }

export function linesOf(messages: Message[]): Line[] {
  return messages
    .filter((m) => m.role !== 'system' && !m.housekeeping && !(m.hidden && m.role === 'assistant'))
    .map((m): Line => ({ who: m.role === 'user' ? (m.hidden ? '（内部消息）' : '用户') : '助手', text: textOf(m) }))
    .filter((l) => l.text)
}

export const fmt = (l: Line, max = Infinity) => `${l.who}：${l.text.length > max ? l.text.slice(0, max) + '……' : l.text}`

const DATE = /\d{1,4}\s*[年月日号]|\d{1,2}[:：]\d{2}|\d{4}-\d{1,2}-\d{1,2}|(周|星期)[一二三四五六日天]|[一二三四五六七八九十]+\s*[月日号]/
const KEYWORD = /记住|决定|定了|定在|改成|截止|预算|日期|发布|上线|必须|一定|不要|别再|别用|不用|以后|偏好|喜欢|讨厌|账号|地址|名字|叫做|代号|暗号|版本|价格|成本|目标|客户|对接|联系人|负责|选了|采用|方案|称呼|邮箱|电话/
const EN_KEYWORD = /\b(prefer|always|never|decided?|call (it|me|us|him|her|them)|named?|contact|deadline|budget|owner|responsible|don't|do not|avoid|please)\b/i
// Who is who: 「管……叫」「叫山海」「找王磊」「由李娜负责」「对接人是王磊」.
const NAMING = /管.{1,12}叫|叫[“「"]?[\p{Script=Han}A-Za-z]{2,}|找[\p{Script=Han}]{2,3}|由[\p{Script=Han}A-Za-z]{2,4}负责|人是[\p{Script=Han}]{2,3}/u
const DIGIT = /\d/

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n]|[.!?](?=\s))/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/** How likely a sentence is to carry a fact someone will need later. */
function factScore(sentence: string): number {
  // A number only counts when the sentence says something besides it (not 「第 3 轮。」).
  const substance = sentence.replace(/第?\s*\d+\s*[轮次条个步]?|[\s\p{P}]/gu, '').length
  return (
    (DATE.test(sentence) ? 3 : 0) +
    (KEYWORD.test(sentence) || EN_KEYWORD.test(sentence) ? 2 : 0) +
    (NAMING.test(sentence) ? 2 : 0) +
    (DIGIT.test(sentence) && substance >= 6 ? 2 : 0)
  )
}

/**
 * Shortens one message to about max characters without losing what matters:
 * its opening, its ending, and the fact-bearing sentences in between.
 */
export function shrink(text: string, max: number): string {
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  const ss = sentencesOf(text)
  if (ss.length <= 2) return text.slice(0, Math.ceil(max * 0.6)) + ' … ' + text.slice(-Math.floor(max * 0.4))
  const clip = (x: string, n: number) => (x.length > n ? x.slice(0, n) + '…' : x)
  const first = clip(ss[0], Math.ceil(max * 0.3))
  const last = clip(ss[ss.length - 1], Math.ceil(max * 0.3))
  let room = max - first.length - last.length
  const middle = ss.slice(1, -1).map((x, i) => ({ x: clip(x, 200), i, score: factScore(x) }))
  const keep = new Set<number>()
  for (const m of [...middle].filter((m) => m.score > 0).sort((a, b) => b.score - a.score)) {
    if (m.x.length + 3 > room) continue
    keep.add(m.i)
    room -= m.x.length + 3
  }
  const kept = middle.filter((m) => keep.has(m.i)).map((m) => m.x)
  return [first, ...kept, last].join(' … ')
}

/**
 * Older messages, condensed by the app itself so early facts survive a
 * handoff whether or not the agent saved them to memory. What the user said
 * is kept longest, and within a message its fact-bearing sentences (dates,
 * numbers, decisions) outlast the rest; the agent's replies are cut first.
 */
export function condense(messages: Message[], budget = 20_000): string {
  const lines = linesOf(messages)
  if (!lines.length) return ''
  const render = (userMax: number, agentMax: number) =>
    lines
      .filter((l) => !(agentMax === 0 && l.who === '助手'))
      .map((l) => `${l.who}：${shrink(l.text, l.who === '助手' ? agentMax : userMax)}`)
  for (const [u, a] of [[1200, 300], [700, 150], [400, 0], [220, 0]] as const) {
    const out = render(u, a)
    if (out.join('\n').length <= budget) return out.join('\n')
  }
  // Still too long: keep how it started, the newest lines, and in between the
  // strongest fact-bearing sentences the user wrote, in their original order.
  const out = render(220, 0)
  const users = lines.filter((l) => l.who !== '助手')
  const head = out.slice(0, 3)
  const tail: string[] = []
  let used = head.join('\n').length + 40
  for (let i = out.length - 1; i >= 3 && used + out[i].length + 1 <= budget * 0.4; i--) {
    tail.unshift(out[i])
    used += out[i].length + 1
  }
  const middleUsers = users.slice(Math.min(3, users.length), Math.max(3, users.length - tail.length))
  const facts = middleUsers.flatMap((l, n) =>
    sentencesOf(l.text.replace(/\s+/g, ' '))
      .map((x, k) => ({ x: x.length > 200 ? x.slice(0, 200) + '…' : x, order: n * 1000 + k, score: factScore(x) }))
      .filter((f) => f.score > 0)
  )
  const chosen: typeof facts = []
  for (const f of [...facts].sort((a, b) => b.score - a.score || b.order - a.order)) {
    if (used + f.x.length + 3 > budget) continue
    chosen.push(f)
    used += f.x.length + 3
  }
  chosen.sort((a, b) => a.order - b.order)
  return [
    ...head,
    `……（中间 ${middleUsers.length} 条用户消息只保留了其中的要点：）`,
    ...chosen.map((f) => `用户（要点）：${f.x}`),
    `……（以下是较近的消息）`,
    ...tail
  ].join('\n')
}

/**
 * The conversation so far, for a fresh agent session: the latest messages
 * verbatim (up to maxRecent messages and maxChars), and everything older
 * condensed. App bookkeeping turns are never replayed.
 */
export function transcript(messages: Message[], maxChars = 24000, maxRecent = Infinity): string {
  const visible = messages.filter((m) => linesOf([m]).length)
  if (!visible.length) return ''
  let cut = visible.length
  let used = 0
  while (cut > 0 && visible.length - cut < maxRecent) {
    const len = fmt(linesOf([visible[cut - 1]])[0]).length + 2
    if (used + len > maxChars && cut < visible.length) break
    used += len
    cut--
  }
  const recent = linesOf(visible.slice(cut)).map((l) => fmt(l)).join('\n\n').slice(-maxChars)
  const earlier = condense(visible.slice(0, cut))
  return [
    `以下是此前的对话记录（会话已重新连接）：`,
    earlier ? `<earlier-summary>\n更早的对话（应用自动整理，较长的内容被截短）：\n${earlier}\n</earlier-summary>` : '',
    `<history>\n${recent}\n</history>`
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * A reply's usage: the tokens the turn reported, plus its cost, worked out from the
 * session's cumulative cost before and after it. Undefined when nothing was reported.
 */
export function turnUsageOf(result: TurnResult, before: Cost | undefined, after: Cost | undefined): MessageUsage | undefined {
  const u: MessageUsage = { ...(result.usage ?? {}) }
  if (after && after !== before && (!before || before.currency === after.currency)) {
    const amount = after.amount - (before?.amount ?? 0)
    if (amount >= 0) u.cost = { amount, currency: after.currency }
  }
  return Object.keys(u).length ? u : undefined
}
