/**
 * Runs conversations: binds each conversation to a backend session, queues
 * turns, folds streamed AgentEvents into persisted messages, and publishes
 * AppEvents. It talks to agents only through BackendManager (the contract).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, rmdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type { AgentEvent, Cost, HostToolServer, ModelInfo, PermissionRequest, SessionContext, SessionInfo, SessionOption, StopReason, TurnResult } from '../../shared/contract'
import { contextLimit } from '../../shared/modelLimits'
import type { PromptPart } from '../../shared/contract'
import type { AppEvent, Attachment, Block, Conversation, Message, QueuedMessage, ReplyModel } from '../../shared/model'
import { addTurn, emptyTotals, type MessageUsage, type UsageTotals } from '../../shared/usage'
import type { BackendManager } from '../backends/BackendManager'
import type { Store } from '../store/Store'
import { t, tk } from '../../shared/i18n'
import { classifyError } from '../../shared/errors'
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
  /** An unattended turn whose routine allows running commands (Routine.allowCommands). */
  allowCommands?: boolean
  /** Not shown in the transcript (e.g. a relayed note or system nudge). */
  hidden?: boolean
  /** Sent to the agent exactly as written: nothing goes before it (a slash command must come first). */
  raw?: boolean
  role?: 'user' | 'system'
  /** The new version of an edited or regenerated turn. */
  variant?: Message['variant']
  /** What started this turn, for the app's own bookkeeping (e.g. a message from another thread). */
  tag?: string
  /** A turn the app runs for a button; see Message.action. */
  action?: Message['action']
}

export interface TurnHooks {
  /** Text placed before the first prompt of a fresh session (instructions, history). */
  preamble?(conv: Conversation, isResume: boolean): string
  /** The user's instructions inside the preamble, to notice when they change during a session. */
  instructions?(conv: Conversation): string
  /** MCP-style tool server the agent session may use. */
  tools?(conv: Conversation): HostToolServer[]
  /**
   * Context for a fresh session of a conversation that already has history.
   * Defaults to replaying the transcript.
   */
  history?(conv: Conversation, prior: Message[]): string | undefined
  /** Text placed before every prompt (e.g. updates that happened since the last turn). */
  beforePrompt?(conv: Conversation): string
  /** Another backend to use for now when the conversation's own is signed out (projects and routines). */
  standIn?(conv: Conversation): string | undefined
  /** Called after each turn finishes. */
  afterTurn?(conv: Conversation, reply: Message, result: TurnResult): void
  /** The user made a folder the working folder from a permission prompt. */
  adoptFolder?(conversationId: string, folder: string): void
}

/** A session opened ahead for the next new chat (ChatService.spares). */
interface Spare {
  backendId: string
  /** The id the new chat takes. */
  id: string
  folder?: string
  system?: string
  info: Promise<SessionInfo | undefined>
  sessionId?: string
  /** What the agent sent for the session before a chat took it. */
  events: AgentEvent[]
  claimed?: SessionInfo
}

interface Live {
  sessionId: string
  backendId: string
  /** Turns and characters exchanged in this session, for deciding when to hand off. */
  turns: number
  chars: number
  /** Set while a session opened ahead of the first message has not been prompted yet: whether it starts empty. */
  unprompted?: { fresh: boolean }
  /** The session's cumulative cost as the backend last reported it (ACP usage_update). */
  cost?: Cost
  /** The agent sent a usage_update during the current turn. */
  reported?: boolean
  /** The last turn read from the agent's own log, so it is never counted twice. */
  turnKey?: string
  /** The app's notes are the session's system prompt (they survive compaction). */
  systemApplied?: boolean
  /** The agent compacted since the last prompt. */
  compacted?: boolean
  /** The user's instructions in this session's system prompt (when systemApplied), as of its opening. */
  systemInstructions?: string
  /** The context the agent last reported, to notice a compaction it didn't announce. */
  contextUsed?: number
  /** The latest compaction in the agent's log (Qoder), to notice the next one. */
  compactionKey?: string
  /** When a turn last started in this session. */
  usedAt?: number
}

interface QueuedTurn {
  id: string
  text: string
  opts: SendOptions
  resolve: () => void
}



/** How long 停止 waits for the agent to end its turn before the app ends it (QA: an agent that hangs ignores the cancel). */
export const STOP_GRACE_MS = 4000

/** An agent's note about the cancel at the end of a stopped reply (sent before the user's stop reached the app). */
const CANCEL_NOTE = /\s*(?:the )?request (?:was|has been) cancell?ed(?: by (?:the )?(?:client|user))?\.?\s*$|\s*\b(?:cancell?ed|aborted) by (?:the )?(?:client|user)\.?\s*$|\s*\b(?:operation |request )?aborted\.?\s*$/i

/** Takes the agent's cancel note off the end of a stopped reply's last text; a block left empty goes. */
export function stripCancelNote(reply: Message): void {
  const i = reply.blocks.map((b) => b.type).lastIndexOf('text')
  const b = reply.blocks[i]
  if (!b || b.type !== 'text' || !CANCEL_NOTE.test(b.text)) return
  const text = b.text.replace(CANCEL_NOTE, '')
  if (text.trim()) reply.blocks[i] = { ...b, text }
  else reply.blocks.splice(i, 1)
}

/** The agent no longer has the session (Antigravity after its helper program exits), as an error or as its reply text. */
export function lostSession(result: TurnResult, reply: Message): boolean {
  if (result.stopReason === 'error') return /\bsession not found\b/i.test(result.error ?? '')
  if (result.stopReason === 'cancelled' || reply.blocks.some((b) => b.type !== 'text' && b.type !== 'thought')) return false
  const text = reply.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
  return text.length < 600 && LOST_TEXT.test(text)
}
const LOST_TEXT = /^agent connection was lost\b/i

/** A short reply that is only the agent saying its usage limit was reached: that text, else undefined. */
export function limitReply(reply: Message): string | undefined {
  if (reply.blocks.some((b) => b.type !== 'text' && b.type !== 'thought')) return undefined
  const text = reply.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
  return text.length < 600 && classifyError(text) === 'limit' ? text : undefined
}

/** `path` is `root` or inside it (case-insensitively where the file system is). */
/** A path with its symlinks resolved; for one that doesn't exist yet (a file about to be written), its nearest existing folder's. */
function realish(path: string): string {
  if (!isAbsolute(path)) return path
  let dir = path
  const rest: string[] = []
  for (let i = 0; i < 64 && !existsSync(dir); i++) {
    const up = dirname(dir)
    if (up === dir) return path
    rest.unshift(basename(dir))
    dir = up
  }
  try {
    return join(realpathSync.native(dir), ...rest)
  } catch {
    return path
  }
}

function within(root: string, path: string): boolean {
  const fold = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (p: string) => (fold ? p.toLowerCase() : p)
  if (!isAbsolute(path)) return false
  const r = relative(norm(root), norm(path))
  return !r.startsWith('..') && !isAbsolute(r)
}

export class ChatService {
  private live = new Map<string, Live>() // conversationId → session
  private bySession = new Map<string, string>() // `${backend}:${session}` → conversationId
  private current = new Map<string, Message>() // conversationId → streaming reply
  private meters = new Map<string, TurnMeter>()
  private queues = new Map<string, QueuedTurn[]>()
  private running = new Set<string>()
  // Running turns the user stopped, possibly before the agent was even connected: they send nothing.
  private stopped = new Set<string>()
  private unattendedTurns = new Set<string>()
  /** Unattended turns allowed to run commands. */
  private commandTurns = new Set<string>()
  /** Called as a queued turn starts, with the tag it was sent with. */
  readonly turnStartListeners = new Set<(conversationId: string, tag?: string) => void>()
  /** Called whenever a conversation is saved (status, resolved, title…). */
  readonly changeListeners = new Set<(conv: Conversation) => void>()
  private tags = new Map<string, string>()
  /** Called after every turn, visible or not, once the conversation is free again. */
  readonly turnEndListeners = new Set<(conversationId: string) => void>()
  /** Called once a conversation is deleted, so every part of the app can drop what it kept for it. */
  /** Called when earlier messages leave the transcript or come back (an edit, a regenerated reply, another variant). */
  readonly rewrittenListeners = new Set<(conversationId: string) => void>()
  readonly removedListeners = new Set<(conversationId: string) => void>()
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
      this.dropSpare(backendId, false)
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
    for (const fn of this.changeListeners) fn(conv)
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

  /** Turns waiting behind the running one. */
  queued(conversationId: string): number {
    return this.queues.get(conversationId)?.length ?? 0
  }

  /** Takes back a turn that is still waiting in the queue; false once it has started. */
  dropQueued(conversationId: string, tag: string): boolean {
    const q = this.queues.get(conversationId) ?? []
    const i = q.findIndex((x) => x.opts.tag === tag)
    if (i < 0) return false
    q.splice(i, 1)[0].resolve()
    this.showQueue(conversationId)
    return true
  }

  /** What the user typed and is still waiting: everything queued that the transcript would show as theirs. */
  private visibleQueue(conversationId: string): QueuedMessage[] {
    return (this.queues.get(conversationId) ?? [])
      .filter((x) => !x.opts.hidden && !x.opts.housekeeping && (x.opts.role ?? 'user') === 'user')
      .map((x) => this.visibleOf(x))
  }

  private visibleOf(x: QueuedTurn): QueuedMessage {
    return { id: x.id, text: x.text, ...(x.opts.attachments?.length ? { attachments: x.opts.attachments } : {}) }
  }

  /** The conversation shows the messages waiting behind the running reply. */
  private showQueue(conversationId: string): void {
    const queued = this.visibleQueue(conversationId)
    const had = this.store.conversation(conversationId)?.queued
    if (!queued.length && !had?.length) return
    this.patchConversation(conversationId, { queued: queued.length ? queued : undefined })
  }

  /** The tag of the turn running now (see SendOptions.tag). */
  turnTag(conversationId: string): string | undefined {
    return this.tags.get(conversationId)
  }

  /** A permission prompt is waiting on the user. */
  awaitingPermission(conversationId: string): boolean {
    for (const cid of this.pendingPermissions.values()) if (cid === conversationId) return true
    return false
  }

  // ---- turns --------------------------------------------------------------

  /** Queues a user turn; resolves when that turn has finished. */
  send(conversationId: string, text: string, opts: SendOptions = {}): Promise<void> {
    return new Promise((resolve) => {
      const q = this.queues.get(conversationId) ?? []
      q.push({ id: randomUUID(), text, opts, resolve })
      this.queues.set(conversationId, q)
      void this.pump(conversationId)
      // pump took it at once when nothing was running; otherwise it waits in view.
      this.showQueue(conversationId)
    })
  }

  private async pump(conversationId: string): Promise<void> {
    if (this.running.has(conversationId)) return
    const q = this.queues.get(conversationId)
    const next = q?.shift()
    if (!next) return
    this.running.add(conversationId)
    this.showQueue(conversationId)
    if (next.opts.unattended) this.unattendedTurns.add(conversationId)
    if (next.opts.unattended && next.opts.allowCommands) this.commandTurns.add(conversationId)
    if (next.opts.tag) this.tags.set(conversationId, next.opts.tag)
    for (const fn of this.turnStartListeners) fn(conversationId, next.opts.tag)
    try {
      await this.runTurn(conversationId, next.text, next.opts)
    } finally {
      this.running.delete(conversationId)
      this.detachCommands(conversationId)
      this.stopped.delete(conversationId)
      if (this.renewAfterTurn.delete(conversationId)) this.forgetSession(conversationId)
      this.unattendedTurns.delete(conversationId)
      this.commandTurns.delete(conversationId)
      this.tags.delete(conversationId)
      for (const fn of this.turnEndListeners) fn(conversationId)
      this.closeIdle(this.live.get(conversationId)?.backendId)
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
      { hidden: opts.hidden, housekeeping: opts.housekeeping || undefined, variant: opts.variant, action: opts.action }
    )

    const reply: Message = {
      id: randomUUID(),
      conversationId,
      role: 'assistant',
      blocks: [],
      createdAt: Date.now(),
      state: 'streaming',
      hidden: opts.hiddenReply || undefined,
      housekeeping: opts.housekeeping || undefined,
      action: opts.action
    }
    this.current.set(conversationId, reply)
    this.updateMessage(reply)
    this.recount(conversationId)
    // The user wrote: whatever the agent was waiting on them for is answered.
    conv = this.patchConversation(conversationId, {
      status: 'working',
      updatedAt: Date.now(),
      ...(!opts.hidden && !opts.housekeeping ? { needsUser: undefined, ...(stalePlan(conv) ? { checklist: undefined } : {}) } : {})
    })!

    let result: TurnResult
    let live: Live | undefined
    let costAtStart: Cost | undefined
    // Starting an agent takes a moment (the first launch may download it): say it is connecting, not thinking.
    if (this.live.get(conversationId)?.backendId !== conv.backendId) {
      const name = this.backends.list().find((b) => b.id === conv!.backendId)?.name ?? 'agent'
      applyEvent(reply.blocks, { kind: 'notice', level: 'info', key: 'starting', text: t('正在连接 {0}…', name) })
      this.scheduleEmit(reply)
    }
    // Instructions in a session's system prompt can't be taken back by a message (a model keeps following
    // them): after a change, this turn goes to a new session, with the conversation so far.
    const bound = this.live.get(conversationId)
    if (!opts.raw && bound?.systemApplied && bound.backendId === conv.backendId && bound.systemInstructions !== (this.hooks.instructions?.(conv) ?? '')) {
      this.forgetSession(conversationId)
      conv = this.patchConversation(conversationId, { sessionRef: undefined }) ?? conv
    }
    try {
      // A session the agent lost (its helper died: "Session not found") is reopened and the message sent again:
      // first by resuming it, then, if that one is lost too, as a fresh session with the history.
      for (let attempt = 0; ; attempt++) {
        // Stopped while the agent is still starting: the reply ends now; the connection carries on for the next message.
        const opening = this.ensureSession(conv)
        opening.catch(() => undefined)
        const stop = new Promise<never>((_, reject) => this.stopWaiters.set(conversationId, () => reject(STOPPED)))
        stop.catch(() => undefined)
        const session = await Promise.race([opening, stop]).finally(() => {
          this.stopWaiters.delete(conversationId)
          const i = reply.blocks.findIndex((b) => b.type === 'notice' && b.key === 'starting')
          if (i >= 0) {
            reply.blocks.splice(i, 1)
            this.scheduleEmit(reply)
          }
        })
        live = session.live
        live.unprompted = undefined
        // The agent's own / command goes to it as typed, with nothing of the app's in front, or it isn't one.
        if (!opts.raw && !attachments.length && (await this.isAgentCommand(conversationId, text))) opts = { ...opts, raw: true }
        if (!session.fresh) await this.applyDeferred(conversationId, live)
        else this.deferred.delete(conversationId)
        let promptText = text
        if (opts.raw) {
          // As written; the app's updates wait for the next turn.
        } else if (session.fresh) {
          // Only a conversation the agent already worked in has history to hand over; a new thread's
          // ack (written by the app) is not a previous session.
          const resumed = prior.some((m) => m.role === 'user')
          const pre = live.systemApplied ? '' : (this.hooks.preamble?.(conv, resumed) ?? '')
          this.patchConversation(conversationId, { instructionsSent: this.hooks.instructions?.(conv) ?? '' })
          const history = resumed ? (this.hooks.history?.(conv, prior) ?? transcript(prior)) : ''
          // After the history: a handoff may already carry what the updates would say.
          const updates = this.hooks.beforePrompt?.(conv) ?? ''
          promptText = [pre, history, updates, history ? `新消息：\n${text}` : text].filter(Boolean).join('\n\n')
        } else {
          const updates = this.hooks.beforePrompt?.(conv) ?? ''
          const note = this.withdrawn.delete(conversationId) ? WITHDRAWN : ''
          // The agent compacted its context, and the notes were only in its first message: hand them over again, first.
          const rules = live.compacted && !live.systemApplied ? this.hooks.preamble?.(conv, true) : ''
          // What the agent has of the user's instructions: the last ones handed over (kept with the chat, so a
          // restart or resume still knows), or after a compaction only what its system prompt holds.
          const sent = live.compacted && live.systemApplied ? live.systemInstructions : this.store.conversation(conversationId)?.instructionsSent
          live.compacted = false
          const now = this.hooks.instructions?.(conv) ?? ''
          const changed = !rules && sent !== undefined && now !== sent
            ? now
              ? `（应用）用户更新了指令，从现在起以这一版为准：\n${now}`
              : '（应用）用户清空了之前给你的指令，那些指令不再适用。'
            : ''
          if (sent !== now) this.patchConversation(conversationId, { instructionsSent: now })
          promptText = [rules, changed, updates, note, text].filter(Boolean).join('\n\n')
        }
        this.withdrawn.delete(conversationId)
        const parts: PromptPart[] = [{ type: 'text', text: promptText }, ...attachments.map(toPart)]
        live.turns++
        live.usedAt = Date.now()
        live.chars += promptText.length
        costAtStart = live.cost
        live.reported = false
        this.meters.set(conversationId, new TurnMeter(performance.now()))
        // 停止 always ends the turn here: an agent that ignores the cancel is let go after STOP_GRACE_MS (see interruptReply).
        const given = new Promise<TurnResult>((resolve) => this.giveUp.set(conversationId, () => resolve({ stopReason: 'cancelled' })))
        result = this.stopped.has(conversationId)
          ? { stopReason: 'cancelled' }
          : await Promise.race([this.backends.prompt(live.backendId, live.sessionId, parts), given]).finally(() => {
              const end = this.giveUp.get(conversationId)
              if (end) clearTimeout(this.stopTimers.get(end))
              if (end) this.stopTimers.delete(end)
              this.giveUp.delete(conversationId)
            })
        if (attempt >= 2 || this.stopped.has(conversationId) || !lostSession(result, reply)) break
        console.warn(`[chat] session ${live.sessionId} was lost by the agent; reopening (${attempt === 0 ? 'resume' : 'new'})`)
        reply.blocks = reply.blocks.filter((b) => b.type !== 'text' && b.type !== 'thought')
        this.scheduleEmit(reply)
        this.forgetSession(conversationId)
        // The resumed one was lost as well: the next opens a new session.
        if (attempt === 1) this.patchConversation(conversationId, { sessionRef: undefined })
        conv = this.store.conversation(conversationId) ?? conv
      }
    } catch (err) {
      result = err === STOPPED ? { stopReason: 'cancelled' } : { stopReason: 'error', error: err instanceof Error ? err.message : String(err) }
    }

    this.flushEmit(reply)
    this.current.delete(conversationId)
    this.rearmSpare(conversationId)
    // The user stopped this turn: however the agent ended it (cancelled, an error such as -32800, or end_turn), it stopped.
    if (this.stopped.has(conversationId)) result = { stopReason: 'cancelled' }
    if (result.stopReason === 'cancelled') stripCancelNote(reply)
    // An agent that says, as an ordinary reply, that its usage limit was reached or that it lost the session
    // (Antigravity): it is a failure to retry, not an answer.
    const limited = result.stopReason !== 'error' && result.stopReason !== 'cancelled'
      ? (limitReply(reply) ?? (lostSession(result, reply) ? textOf(reply).trim() : undefined))
      : undefined
    if (limited) {
      result = { stopReason: 'error', error: limited }
      reply.blocks = reply.blocks.filter((b) => b.type !== 'text' && b.type !== 'thought')
      this.meters.delete(conversationId)
    }
    reply.state = result.stopReason === 'error' ? 'error' : result.stopReason === 'cancelled' ? 'cancelled' : 'done'
    if (result.error) reply.error = result.error
    // An agent command it carried out without a word (Grok's /always-approve): say it ran.
    const command = /^\/[^\s]+/.exec(text.trim())?.[0]
    // The agent's /rename names its own session; the conversation here takes the same name.
    const renamed = command?.toLowerCase() === '/rename' && reply.state === 'done' ? text.trim().slice(command.length).trim().slice(0, 120) : ''
    if (renamed) this.patchConversation(conversationId, { title: renamed, titleAuto: false })
    if (reply.state === 'done' && !reply.blocks.length && command && (opts.raw || renamed) && !opts.action)
      reply.blocks.push({ type: 'notice', level: 'info', text: renamed ? t('已重命名为「{0}」。', renamed) : t('{0} 已执行，没有返回内容。', command) })
    // The agent stopped short of finishing on its own: say why, so a cut-off reply doesn't read as complete.
    const short = STOPPED_SHORT[result.stopReason]
    if (short) reply.blocks.push({ type: 'notice', level: 'warning', text: t(short) })
    // Agents that report little over ACP (Grok) write it to their own log: read the turn from there.
    let logged: SessionContext | undefined
    if (live && result.stopReason !== 'error' && (!result.usage || !live.reported)) {
      logged = await this.backends.sessionContext(live.backendId, live.sessionId)
      if (logged?.turnKey && logged.turnKey === live.turnKey) logged = { ...logged, turn: undefined }
      else if (logged?.turnKey) live.turnKey = logged.turnKey
      // A compaction the agent logged but didn't announce: the next prompt carries the rules again.
      if (logged?.compactionKey && logged.compactionKey !== live.compactionKey) {
        live.compactionKey = logged.compactionKey
        live.compacted = true
      }
      if (logged?.turn && !result.usage) result = { ...result, usage: logged.turn }
    }
    const usage = limited ? undefined : turnUsageOf(result, costAtStart, live?.cost)
    if (usage) reply.usage = usage
    if (usage) reply.model = this.replyModel(conversationId, live?.backendId)
    // An agent's own / command is answered by the program, not the model: it says nothing about speed.
    reply.timing = opts.raw ? undefined : this.meters.get(conversationId)?.finish(result.usage, result.stopReason,
      !this.backends.list().find((b) => b.id === conv!.backendId)?.credits)
    this.meters.delete(conversationId)
    this.updateMessage(reply)
    // A turn that failed before the agent answered says nothing about what the backend reports,
    // nor does an agent's own / command (the program answers it, no model runs).
    if (usage || (live && result.stopReason !== 'error' && !opts.raw)) {
      const c = this.store.conversation(conversationId)
      if (c) this.patchConversation(conversationId, { usage: { ...addTurn(c.usage, usage), ...contextOf(c.usage) } })
    }
    if (live && !live.reported && logged?.used !== undefined) this.setLoggedContext(conversationId, logged)

    if (live) live.chars += JSON.stringify(reply.blocks).length
    // If the save-memory turn failed, keep the session: rotating now would lose what it didn't save.
    if (opts.rotateAfter && result.stopReason !== 'error') this.rotate(conversationId)

    const preview = plainPreview(textOf(reply))
    const after = this.patchConversation(conversationId, {
      status: result.stopReason === 'error' ? 'error' : 'idle',
      ...(opts.hiddenReply ? {} : { updatedAt: Date.now(), lastPreview: preview || this.store.conversation(conversationId)?.lastPreview, unread: true,
        ...(!opts.housekeeping && !opts.raw ? { timing: reply.timing } : {}) })
    })
    // The conversation may have been deleted while the reply ran.
    if (after && !opts.hiddenReply) this.hooks.afterTurn?.(after, reply, result)
  }

  /** How much the current agent session of a conversation has seen. */
  sessionLoad(conversationId: string): { turns: number; chars: number } | undefined {
    const l = this.live.get(conversationId)
    return l && { turns: l.turns, chars: l.chars }
  }

  /**
   * `/name …` naming a command the agent offers. A session that just opened may list its commands
   * a moment after it answers, so a / message waits briefly for that list.
   */
  private async isAgentCommand(conversationId: string, text: string): Promise<boolean> {
    const name = /^\/(\S+)/.exec(text.trim())?.[1]
    if (!name) return false
    const has = () => !!this.store.conversation(conversationId)?.agentCommands?.some((c) => c.name === name)
    for (let i = 0; i < 10 && !has() && !this.store.conversation(conversationId)?.agentCommands?.length; i++) await new Promise((r) => setTimeout(r, 100))
    return has()
  }

  /** Ends the wait for a session that is still opening, when its reply is stopped. */
  private stopWaiters = new Map<string, () => void>()

  /** Ends the current agent session; the next turn starts fresh with a handoff. */
  /** The user's working folder for a conversation: its own, or its project's. */
  folderOf(conv: Conversation): string | undefined {
    return conv.cwd || this.store.project(conv.projectId)?.cwd || undefined
  }

  /** Where an agent works for a conversation with no folder, until it makes files (see AppCore.placeChat). */
  scratchPath(conversationId: string): string {
    return join(this.store.dir, 'workspaces', conversationId.replace(/[^a-zA-Z0-9-]/g, ''))
  }

  private scratchDir(conversationId: string): string {
    const dir = this.scratchPath(conversationId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  rotate(conversationId: string): void {
    this.forgetSession(conversationId)
    this.patchConversation(conversationId, { sessionRef: undefined })
  }

  /**
   * Per agent, a session opened ahead for the next new chat, where opening one takes seconds even
   * in a running agent (AgentBackend.wantsSpare). It is made for the chat's id-to-be, so its scratch
   * folder and the app's tools are already that chat's; what the agent says meanwhile is kept for it.
   */
  private spares = new Map<string, Spare>()

  /** Opens the next new chat's session ahead (see spares); `folder` is the one the new chat will have. */
  prepareSpare(backendId: string, folder?: string): void {
    folder ||= undefined
    const have = this.spares.get(backendId)
    if ((have && have.folder === folder) || !this.backends.wantsSpare(backendId)) return
    if (have) this.dropSpare(backendId)
    const now = Date.now()
    const conv: Conversation = { id: randomUUID(), kind: 'chat', title: '', backendId, cwd: folder, createdAt: now, updatedAt: now, status: 'idle' }
    const system = this.hooks.preamble?.(conv, false) || undefined
    const spare: Spare = { backendId, id: conv.id, folder, system, events: [], info: Promise.resolve(undefined) }
    spare.info = this.backends
      .newSession(backendId, { cwd: folder ?? this.scratchDir(conv.id), folder, tools: this.hooks.tools?.(conv), system })
      .then((info) => {
        if (this.spares.get(backendId) !== spare) return void this.backends.discardSession(backendId, info.sessionId)
        spare.sessionId = info.sessionId
        return info
      })
      .catch(() => {
        if (this.spares.get(backendId) === spare) this.dropSpare(backendId, false)
        return undefined
      })
    this.spares.set(backendId, spare)
  }

  /** The session opened ahead for this agent's next new chat, if any. */
  spareOf(backendId: string): { folder?: string } | undefined {
    const spare = this.spares.get(backendId)
    return spare && { folder: spare.folder }
  }

  /** What the session opened ahead offers (models, choices), once it is open: a picker reads it instead of opening another. */
  spareInfo(backendId: string): Promise<SessionInfo | undefined> | undefined {
    return this.spares.get(backendId)?.info
  }

  /** The id a new chat with this agent in `folder` takes, so it gets the session opened ahead for it. */
  spareId(backendId: string, folder?: string): string | undefined {
    const spare = this.spares.get(backendId)
    return spare && spare.folder === (folder || undefined) ? spare.id : undefined
  }

  /** Forgets the session opened ahead (closing it in the agent, unless the agent's process is gone). */
  dropSpare(backendId: string, close = true): void {
    const spare = this.spares.get(backendId)
    if (!spare) return
    this.spares.delete(backendId)
    // One still opening is closed once it has (see prepareSpare).
    if (close && spare.sessionId) this.backends.discardSession(backendId, spare.sessionId)
    if (!spare.folder)
      try {
        rmdirSync(this.scratchPath(spare.id))
      } catch {
        // Not empty, or already gone.
      }
  }

  /** The session opened ahead for this very chat, when it was opened the way the chat would open one now. */
  private async claimSpare(conv: Conversation, folder: string | undefined, system: string | undefined): Promise<Spare | undefined> {
    const spare = this.spares.get(conv.backendId)
    if (!spare || spare.id !== conv.id) return undefined
    this.spares.delete(conv.backendId)
    const info = await withTimeout(spare.info, CONNECT_TIMEOUT, '').catch(() => undefined)
    if (!info || spare.folder !== folder || spare.system !== system) {
      if (info) this.backends.discardSession(conv.backendId, info.sessionId)
      return undefined
    }
    spare.claimed = info
    // The next new chat gets one too, once this chat's first reply is in: opening it now would hold that reply up
    // (an agent opens one session at a time). The new-chat page asks for one again whenever it shows, too.
    this.rearm.set(conv.id, { backendId: conv.backendId, folder })
    return spare
  }

  /** Chats that took the spare session: the next one is opened once their first turn ends (see claimSpare). */
  private rearm = new Map<string, { backendId: string; folder?: string }>()

  private rearmSpare(conversationId: string): void {
    const next = this.rearm.get(conversationId)
    if (!next) return
    this.rearm.delete(conversationId)
    this.prepareSpare(next.backendId, next.folder)
  }

  /** Sessions being opened, so a message sent meanwhile waits for the same one. */
  private connecting = new Map<string, Promise<{ live: Live; fresh: boolean }>>()
  // Bumped whenever a conversation's session is dropped: a session still opening for the old backend is then discarded.
  private epochs = new Map<string, number>()

  /**
   * Opens the conversation's agent session ahead of the first message, while
   * the user is still reading or typing, so sending only sends. Nothing is
   * prompted; failures are left for the send to report.
   */
  prepare(conversationId: string): void {
    const conv = this.store.conversation(conversationId)
    if (!conv || conv.status === 'working' || conv.status === 'waiting' || !this.backends.has(conv.backendId)) return
    if (this.live.get(conv.id)?.backendId === conv.backendId || this.connecting.has(conv.id)) return
    // An agent that holds a program per open session (Antigravity) reopens one only when a message goes to it.
    if (this.backends.openSessionLimit(conv.backendId)) return
    this.ensureSession(conv).catch(() => undefined)
  }

  /** Opens the conversation's agent session now, without prompting (e.g. to switch its model). */
  async open(conversationId: string): Promise<void> {
    const conv = this.store.conversation(conversationId)
    if (conv) await this.ensureSession(conv)
  }

  private async ensureSession(conv: Conversation): Promise<{ live: Live; fresh: boolean }> {
    const existing = this.live.get(conv.id)
    if (existing && existing.backendId === conv.backendId) return { live: existing, fresh: existing.unprompted?.fresh ?? false }
    const pending = this.connecting.get(conv.id)
    if (pending) {
      const done = await pending.catch(() => undefined)
      if (done && done.live.backendId === conv.backendId && this.live.get(conv.id) === done.live) return { live: done.live, fresh: done.live.unprompted?.fresh ?? false }
    }
    const opening = this.openSession(conv)
    this.connecting.set(conv.id, opening)
    try {
      return await opening
    } finally {
      if (this.connecting.get(conv.id) === opening) this.connecting.delete(conv.id)
    }
  }

  private async openSession(saved: Conversation): Promise<{ live: Live; fresh: boolean }> {
    const epoch = this.epochs.get(saved.id) ?? 0
    // The conversation switched backend (or dropped its session) while this one was opening.
    const stale = () => {
      if ((this.epochs.get(saved.id) ?? 0) !== epoch) throw new Error(t('已切换后端，旧的会话不再使用。'))
    }
    // A stand-in runs this session only: the conversation keeps its backend, model and choices.
    const standIn = this.hooks.standIn?.(saved)
    const conv: Conversation = standIn
      ? { ...saved, backendId: standIn, modelId: undefined, optionValues: undefined, sessionRef: saved.sessionRef?.backendId === standIn ? saved.sessionRef : undefined }
      : saved
    if (standIn) {
      const nameOf = (id: string) => this.backends.list().find((b) => b.id === id)?.name ?? id
      this.notice(saved.id, 'info', t('{0} 未登录，本次用 {1}', nameOf(saved.backendId), nameOf(standIn)), 'stand-in')
    }
    // With a working folder the agent works there; without one it gets a private, empty
    // folder of its own, so it never lands in the user's home by default.
    const folder = this.folderOf(conv)
    // The app's notes go in as a system prompt where the agent takes one: they then outlive its compaction.
    const opts = { cwd: folder ?? this.scratchDir(conv.id), folder, tools: this.hooks.tools?.(conv), system: this.hooks.preamble?.(conv, false) || undefined }

    // After a restart, reattach to the agent's own session when the backend can.
    let info: SessionInfo | null = null
    let fresh = true
    if (conv.sessionRef?.backendId === conv.backendId) {
      info = await withTimeout(this.backends.resumeSession(conv.backendId, conv.sessionRef.sessionId, opts), CONNECT_TIMEOUT, '').catch(() => null)
      fresh = !info
    }
    const name = this.backends.list().find((b) => b.id === conv.backendId)?.name ?? conv.backendId
    const spare = info || standIn ? undefined : await this.claimSpare(conv, folder, opts.system)
    if (spare?.claimed) info = spare.claimed
    info ??= await withTimeout(this.backends.newSession(conv.backendId, opts), CONNECT_TIMEOUT,
      t('{0} 在 {1} 秒内没有连上。请确认它在终端里能正常运行，然后点重试。', name, CONNECT_TIMEOUT / 1000))

    stale()
    const live: Live = { sessionId: info.sessionId, backendId: conv.backendId, turns: 0, chars: 0, unprompted: { fresh }, systemApplied: info.systemApplied }
    // A system prompt carries the instructions as they are now (a resumed session gets the current one too).
    if (info.systemApplied) {
      live.systemInstructions = this.hooks.instructions?.(conv) ?? ''
      this.patchConversation(conv.id, { instructionsSent: live.systemInstructions })
    }
    // A new session starts with an empty context; the old session's figures no longer apply.
    if (fresh) {
      const u = this.store.conversation(conv.id)?.usage
      if (u && (u.contextUsed !== undefined || u.contextSize !== undefined))
        this.patchConversation(conv.id, { usage: { ...u, contextUsed: undefined, contextSize: undefined, contextSource: undefined, contextSizeSource: undefined } })
    }
    this.live.set(conv.id, live)
    // A reopened session has said nothing yet: its own log shows how full it already is.
    if (!fresh) void this.readLoggedContext(conv.id, live)
    this.bySession.set(`${conv.backendId}:${info.sessionId}`, conv.id)
    // A new session's offered options replace the previous session's capabilities.
    if (!standIn) this.patchConversation(conv.id, { sessionOptions: info.options ?? [] })
    // What the agent said while the session waited for this chat (its / commands, its options).
    for (const e of spare?.events ?? []) this.onAgentEvent(conv.backendId, info.sessionId, e)
    // What the user picked while the session was opening counts, not what it was when opening began.
    const latest = this.store.conversation(conv.id)
    const wantModel = standIn ? undefined : (latest?.modelId ?? conv.modelId)
    const wantOptions = standIn ? undefined : (latest?.optionValues ?? conv.optionValues)
    let modelId = info.currentModelId
    if (wantModel && wantModel !== info.currentModelId && info.models?.some((m) => m.id === wantModel)) {
      try { await this.backends.setModel(conv.backendId, info.sessionId, wantModel) }
      catch (error) { this.forgetSession(conv.id); throw error }
      stale()
      modelId = wantModel
    }
    // The conversation's own choices win; a new conversation starts with the backend's defaults.
    let options = this.store.conversation(conv.id)?.sessionOptions ?? info.options
    // A mode is never a default for new chats (an earlier version could save one); other choices are.
    const defaults = sessionOptionDefaults(this.store.settings, conv.backendId, modelId ?? conv.modelId)
    for (const o of options ?? []) {
      const v = wantOptions?.[o.id] ?? (o.category === 'mode' ? undefined : defaults[o.id])
      if (!v || v === o.current || !o.choices.some((c) => c.value === v)) continue
      try {
        options = (await this.backends.setOption(conv.backendId, info.sessionId, o.id, v)) ?? options?.map((x) => (x.id === o.id ? { ...x, current: v } : x))
      } catch (error) { this.forgetSession(conv.id); throw error }
    }
    stale()
    // A model picked after `latest` went to this live session directly; it stands.
    const now = this.store.conversation(conv.id)?.modelId
    this.patchConversation(conv.id, standIn ? { sessionRef: live } : {
      models: info.models ?? conv.models,
      modelId: now !== latest?.modelId ? now : (modelId ?? conv.modelId),
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

  async cancel(conversationId: string): Promise<QueuedMessage[]> {
    // Turns still queued are not sent: the user's own go back to them (the composer), whoever waits is let go.
    const back = this.visibleQueue(conversationId)
    for (const q of this.queues.get(conversationId) ?? []) q.resolve()
    this.queues.delete(conversationId)
    this.showQueue(conversationId)
    await this.interruptReply(conversationId)
    return back
  }

  /** Ends a turn whose agent ignored 停止 (see interruptReply). */
  private giveUp = new Map<string, () => void>()
  /** The give-up timer of a stopped turn, by that turn's giveUp. */
  private stopTimers = new Map<() => void, ReturnType<typeof setTimeout>>()

  /** Stops the running reply only; what is queued goes next. */
  private async interruptReply(conversationId: string): Promise<void> {
    if (this.running.has(conversationId)) {
      this.stopped.add(conversationId)
      this.stopWaiters.get(conversationId)?.()
      const live = this.live.get(conversationId)
      if (live) {
        // An agent that doesn't answer the cancel (it hangs) mustn't keep the chat 运行中 with its queue stuck:
        // the turn ends here after a few seconds, and the agent is started again once nothing else runs on it.
        // Bound to this turn: one that ends meanwhile clears it, and a next turn is never cut off by it.
        const end = this.giveUp.get(conversationId)
        if (end) {
          const timer = setTimeout(() => {
            this.stopTimers.delete(end)
            if (this.giveUp.get(conversationId) !== end) return
            end()
            this.forgetSession(conversationId)
            // Its hung reply still counts as running in the agent; another chat's reply on it would be cut off.
            const others = [...this.running].some((id) => id !== conversationId && this.live.get(id)?.backendId === live.backendId)
            if (!others) void this.backends.restart(live.backendId).catch(() => undefined)
          }, STOP_GRACE_MS)
          timer.unref?.()
          this.stopTimers.set(end, timer)
        }
        await withTimeout(this.backends.cancel(live.backendId, live.sessionId), STOP_GRACE_MS, '').catch(() => undefined)
      }
    }
    // Dismiss any permission prompt this turn is waiting on.
    for (const [rid, cid] of this.pendingPermissions) if (cid === conversationId) this.respondPermission(rid, null)
  }

  /**
   * A queued message the user acts on: 'now' moves it to the front and stops the reply, so it goes next
   * (a model picked meanwhile still applies first); 'take' removes it and hands it back.
   */
  async queuedMessage(conversationId: string, id: string, action: 'now' | 'take'): Promise<QueuedMessage | undefined> {
    const q = this.queues.get(conversationId) ?? []
    const i = q.findIndex((x) => x.id === id)
    if (i < 0) return
    const [turn] = q.splice(i, 1)
    const message = this.visibleOf(turn)
    if (action === 'take') {
      turn.resolve()
      this.showQueue(conversationId)
      return message
    }
    q.unshift(turn)
    this.showQueue(conversationId)
    await this.interruptReply(conversationId)
    return message
  }

  /**
   * Model and option changes made while a reply runs: they apply before the next
   * turn instead of mid-turn (not every agent takes a model change mid-reply).
   */
  private deferred = new Map<string, { model?: string; options: Record<string, string> }>()

  private defer(conversationId: string): { model?: string; options: Record<string, string> } {
    let d = this.deferred.get(conversationId)
    if (!d) this.deferred.set(conversationId, (d = { options: {} }))
    return d
  }

  /** Applies what was changed during the last reply to the live session, before the next prompt. */
  private async applyDeferred(conversationId: string, live: Live): Promise<void> {
    const d = this.deferred.get(conversationId)
    if (!d) return
    this.deferred.delete(conversationId)
    if (d.model) await this.backends.setModel(live.backendId, live.sessionId, d.model)
    for (const [id, value] of Object.entries(d.options)) await this.backends.setOption(live.backendId, live.sessionId, id, value)
  }

  async setModel(conversationId: string, modelId: string): Promise<void> {
    // A session still opening takes the pick when it is ready (see openSession).
    const opening = this.connecting.get(conversationId)
    if (opening && !this.live.get(conversationId)) {
      this.patchConversation(conversationId, { modelId })
      await opening.catch(() => undefined)
    }
    const live = this.live.get(conversationId)
    if (live && this.running.has(conversationId)) this.defer(conversationId).model = modelId
    else if (live) await this.backends.setModel(live.backendId, live.sessionId, modelId)
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
    if (live && this.running.has(conversationId)) this.defer(conversationId).options[optionId] = value
    else if (live) options = (await this.backends.setOption(live.backendId, live.sessionId, optionId, value)) ?? options
    this.patchConversation(conversationId, { sessionOptions: options, optionValues: { ...conv.optionValues, [optionId]: value } })
  }

  /**
   * Sets aside a message and everything after it as an older version of that
   * turn, and starts a new agent session (the old one remembers the removed
   * turns). The next turn replays the rest. Returns the new version's info.
   */
  async rewind(conversationId: string, fromMessageId: string): Promise<Message['variant']> {
    await this.stopTurn(conversationId)
    // Retrying or editing the last exchange keeps the agent's session (and its cache): the next
    // prompt tells it that exchange was withdrawn. Anything further back needs a fresh replay.
    const list = this.store.messagesOf(conversationId)
    const lastUser = [...list].reverse().find((m) => m.role === 'user' && !m.hidden && !m.housekeeping)
    const keep = lastUser?.id === fromMessageId && this.live.has(conversationId)
    const { removed, variant } = this.store.archiveFrom(conversationId, fromMessageId)
    for (const m of removed) this.publish({ type: 'message-removed', conversationId, id: m.id })
    for (const fn of this.rewrittenListeners) fn(conversationId)
    if (keep) this.withdrawn.add(conversationId)
    else this.restartSession(conversationId)
    return variant
  }

  /** The agent and model a reply came from, named as the model menu named it. */
  private replyModel(conversationId: string, backendId?: string): ReplyModel | undefined {
    const conv = this.store.conversation(conversationId)
    if (!conv) return undefined
    const id = conv.modelId ?? conv.models?.[0]?.id
    const name = conv.models?.find((m) => m.id === id)?.name
    return { backendId: backendId ?? conv.backendId, ...(id ? { id } : {}), ...(name ? { name } : {}) }
  }

  /** Commands still running when their reply ended are background work from now on. */
  private detachCommands(conversationId: string): void {
    const list = this.store.conversation(conversationId)?.background
    if (!list?.some((b) => !b.endedAt && !b.managed && !b.detached)) return
    this.patchConversation(conversationId, { background: list.map((b) => (!b.endedAt && !b.managed ? { ...b, detached: true } : b)) })
  }

  /** The end of what a background command printed: from the agent's output file, the running terminal, or what was kept when it ended. */
  async commandOutput(conversationId: string, id: string): Promise<string> {
    const entry = this.store.conversation(conversationId)?.background?.find((b) => b.id === id)
    if (!entry) return ''
    if (entry.outputFile) {
      const tail = await readTail(entry.outputFile, 16_000)
      if (tail !== undefined) return tail
    }
    const live = this.live.get(conversationId)
    const now = live && !entry.endedAt ? await this.backends.commandOutput(live.backendId, live.sessionId, id).catch(() => undefined) : undefined
    return now ?? entry.output ?? ''
  }

  /** Stops a command the conversation's agent runs through the app. */
  async stopCommand(conversationId: string, id: string): Promise<void> {
    const live = this.live.get(conversationId)
    if (!live || !(await this.backends.stopCommand(live.backendId, live.sessionId, id))) throw new Error(t('这个命令已经结束了'))
  }

  /**
   * Runs the agent's own compact command now. Its result stays out of a later replay; afterwards
   * the app's notes go first in the next message unless they are the session's system prompt.
   */
  async compactContext(conversationId: string): Promise<void> {
    const conv = this.store.conversation(conversationId)
    // After a restart the session isn't open yet; sending the command resumes it first, as any message does.
    if (!conv?.compactCommand || (!this.live.has(conversationId) && conv.sessionRef?.backendId !== conv.backendId))
      throw new Error(t('这个 agent 现在不能手动压缩上下文'))
    const done = (id: string) => {
      if (id !== conversationId) return
      this.turnEndListeners.delete(done)
      const now = this.live.get(conversationId)
      if (now) now.compacted = true
    }
    this.turnEndListeners.add(done)
    await this.send(conversationId, '/' + conv.compactCommand, { raw: true, housekeeping: true, action: 'compact' })
  }

  /** Conversations whose last exchange was withdrawn while keeping the session (see rewind). */
  private withdrawn = new Set<string>()

  /** Shows another version of an edited or regenerated turn; the next turn continues from it. */
  async switchVariant(conversationId: string, group: string, index: number): Promise<void> {
    await this.stopTurn(conversationId)
    const r = this.store.switchVariant(conversationId, group, index)
    if (!r) return
    for (const m of r.removed) this.publish({ type: 'message-removed', conversationId, id: m.id })
    for (const m of r.restored) this.publish({ type: 'message', message: m })
    for (const fn of this.rewrittenListeners) fn(conversationId)
    this.restartSession(conversationId)
  }

  /** Stops the running reply, if any, and waits until its turn has wound down. */
  async stopTurn(conversationId: string): Promise<void> {
    if (this.running.has(conversationId)) await this.cancel(conversationId)
    await until(() => !this.running.has(conversationId))
  }
  /** The agent's session remembers the turns now off screen: start fresh, replaying what is shown. */
  private restartSession(conversationId: string) {
    this.forgetSession(conversationId)
    this.patchConversation(conversationId, { sessionRef: undefined })
    this.recount(conversationId)
  }

  // Running conversations whose session is dropped once their turn ends (see renewSession).
  private renewAfterTurn = new Set<string>()

  /** Deletes a conversation: stops its turn, forgets its session and everything kept for it, then tells the rest of the app. */
  async removeConversation(conversationId: string): Promise<void> {
    await this.cancel(conversationId).catch(() => {})
    this.forgetSession(conversationId)
    for (const m of [this.meters, this.tags, this.epochs, this.current, this.rearm]) m.delete(conversationId)
    for (const s of [this.renewAfterTurn, this.unattendedTurns, this.commandTurns]) s.delete(conversationId)
    clearTimeout(this.emitTimers.get(conversationId))
    this.emitTimers.delete(conversationId)
    this.store.removeConversation(conversationId)
    this.publish({ type: 'conversation-removed', id: conversationId })
    for (const fn of this.removedListeners) fn(conversationId)
  }

  /** Takes blocks out of a conversation's messages (e.g. the card of a deleted thread). */
  stripBlocks(conversationId: string, drop: (b: Block) => boolean): void {
    for (const m of this.store.messagesOf(conversationId)) {
      const kept = m.blocks.filter((b) => !drop(b))
      if (kept.length !== m.blocks.length) this.updateMessage({ ...m, blocks: kept })
    }
  }

  /**
   * The app's tool list changed (computer control turned on or off): agents read it
   * once per session, so each session is reopened (resumed where the agent can)
   * before its next turn, or after the turn it is in.
   */
  refreshTools(): void {
    for (const id of [...this.live.keys()]) this.renewSession(id)
  }

  /** The next turn opens a new session (with the conversation so far); a running one finishes first. */
  renewSession(conversationId: string): void {
    if (this.running.has(conversationId)) this.renewAfterTurn.add(conversationId)
    else this.forgetSession(conversationId)
  }

  /**
   * An agent that holds a program per open session (Antigravity) keeps only its most recently used
   * idle sessions open; the others are closed and reopened (resumed where it can) on their next message.
   */
  private closeIdle(backendId: string | undefined): void {
    const limit = backendId ? this.backends.openSessionLimit(backendId) : undefined
    if (!limit) return
    const busy = (id: string) => this.running.has(id) || this.current.has(id) || this.connecting.has(id) || !!this.queues.get(id)?.length || [...this.shownPermissions.values()].some((p) => p.conversationId === id)
    const open = [...this.live].filter(([, l]) => l.backendId === backendId)
    const idle = open.filter(([id]) => !busy(id)).sort((a, b) => (a[1].usedAt ?? 0) - (b[1].usedAt ?? 0))
    for (let extra = open.length - limit; extra > 0 && idle.length; extra--) this.forgetSession(idle.shift()![0])
  }

  forgetSession(conversationId: string): void {
    this.epochs.set(conversationId, (this.epochs.get(conversationId) ?? 0) + 1)
    this.connecting.delete(conversationId)
    const live = this.live.get(conversationId)
    if (live) {
      this.bySession.delete(`${live.backendId}:${live.sessionId}`)
      // Closed in the agent too (it stays in its history, to resume): an open one holds the agent's resources.
      this.backends.releaseSession(live.backendId, live.sessionId)
    }
    this.live.delete(conversationId)
    this.deferred.delete(conversationId)
    this.withdrawn.delete(conversationId)
  }

  // ---- permissions --------------------------------------------------------

  routePermission(backendId: string, request: PermissionRequest): void {
    const conversationId = this.bySession.get(`${backendId}:${request.sessionId}`)
    const auto = conversationId ? this.autoAnswer(conversationId, request) : undefined
    if (auto) {
      this.backends.respondPermission(request.requestId, auto.decision)
      if (auto.note) this.notice(conversationId!, 'info', auto.note)
      return
    }
    if (conversationId) {
      this.meters.get(conversationId)?.interrupt()
      this.pendingPermissions.set(request.requestId, conversationId)
      this.patchConversation(conversationId, { status: 'waiting', needsUser: { kind: 'permission', text: request.title, at: Date.now() } })
    }
    this.showPermission(conversationId, request)
  }

  /**
   * Answers what needn't wait for the user (who may be away): an agent reading or searching, or editing
   * files inside the chat's own working folder, goes ahead; a run nobody watches (a scheduled task,
   * a board refresh) skips anything else and says so in its reply. The rest is asked inline, in its chat.
   */
  private autoAnswer(conversationId: string, request: PermissionRequest): { decision: string | null; note?: string } | undefined {
    const pick = (...kinds: PermissionRequest['options'][number]['kind'][]) => kinds.map((k) => request.options.find((o) => o.kind === k)).find(Boolean)?.id
    const conv = this.store.conversation(conversationId)
    if (!conv) return undefined
    const unattended = this.isUnattended(conversationId)
    const allow = pick('allow_once', 'allow_always')
    if (allow && !request.apps && request.toolKind) {
      const kind = request.toolKind
      // Inside the chat's own folders, symlinks resolved, so a link can't lead an "inside" path elsewhere.
      const roots = [this.folderOf(conv), this.scratchPath(conv.id)].filter((r): r is string => !!r).map(realish)
      const inside = !!request.paths?.length && request.paths.every((p) => roots.some((r) => within(r, realish(p))))
      // Thinking and fetching a web page touch no files here.
      if (kind === 'think' || kind === 'fetch') return { decision: allow }
      if ((kind === 'read' || kind === 'search') && (inside || this.store.settings.allowOutsideReads)) return { decision: allow }
      if (kind === 'edit' && inside) return { decision: allow }
      if (kind === 'execute' && unattended && this.commandTurns.has(conversationId)) return { decision: allow }
    }
    if (!unattended) return undefined
    return { decision: pick('reject_once', 'reject_always') ?? null, note: t('无人值守运行，没有人能确认，已跳过：{0}', request.title) }
  }

  /** Prompts on screen now, by request id: a reloaded window (language switch, a reopened macOS window) shows them again. */
  private shownPermissions = new Map<string, { conversationId?: string; request: PermissionRequest }>()

  private showPermission(conversationId: string | undefined, request: PermissionRequest): void {
    this.shownPermissions.set(request.requestId, { conversationId, request })
    this.publish({ type: 'permission', conversationId, request })
  }

  /** The permission prompts still waiting for an answer, oldest first. */
  pendingRequests(): { conversationId?: string; request: PermissionRequest }[] {
    return [...this.shownPermissions.values()]
  }

  /** A backend dropped a permission prompt on its own (e.g. it crashed). */
  permissionDropped(requestId: string): void {
    this.pendingPermissions.delete(requestId)
    this.shownPermissions.delete(requestId)
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
    // Nobody is there to answer in an unattended run: the question is skipped at once, and the reply says so.
    if (this.isUnattended(conversationId)) {
      this.notice(conversationId, 'info', t('无人值守运行，没有人能确认，已跳过：{0}', q.title))
      return Promise.resolve(null)
    }
    this.meters.get(conversationId)?.interrupt()
    return new Promise((resolve) => {
      this.hostWaiters.set(requestId, resolve)
      if (timeoutMs) setTimeout(() => this.hostWaiters.has(requestId) && this.respondPermission(requestId, null), timeoutMs)
      this.pendingPermissions.set(requestId, conversationId)
      this.patchConversation(conversationId, { status: 'waiting', needsUser: { kind: 'permission', text: q.title, at: Date.now() } })
      this.showPermission(conversationId, { ...q, requestId, sessionId: '' })
    })
  }

  respondPermission(requestId: string, decision: string | null): void {
    const conversationId = this.pendingPermissions.get(requestId)
    this.pendingPermissions.delete(requestId)
    const host = this.hostWaiters.get(requestId)
    this.hostWaiters.delete(requestId)
    if (host) host(decision)
    else this.backends.respondPermission(requestId, decision)
    this.shownPermissions.delete(requestId)
    this.publish({ type: 'permission-resolved', requestId })
    const answered = conversationId && this.store.conversation(conversationId)?.needsUser?.kind === 'permission' && !this.awaitingPermission(conversationId)
    if (conversationId && this.running.has(conversationId)) this.patchConversation(conversationId, { status: 'working', ...(answered ? { needsUser: undefined } : {}) })
    else if (answered) this.patchConversation(conversationId, { needsUser: undefined })
  }

  // ---- streaming ----------------------------------------------------------

  private async readLoggedContext(conversationId: string, live: Live): Promise<void> {
    const ctx = await this.backends.sessionContext(live.backendId, live.sessionId)
    if (!ctx || this.live.get(conversationId) !== live) return
    live.turnKey ??= ctx.turnKey
    live.compactionKey ??= ctx.compactionKey
    if (ctx.used !== undefined && this.store.conversation(conversationId)?.usage?.contextSource !== 'agent') this.setLoggedContext(conversationId, ctx)
  }

  /** Context figures read from the agent's own log; a size the agent reported is kept. */
  private setLoggedContext(conversationId: string, ctx: SessionContext): void {
    const c = this.store.conversation(conversationId)
    if (!c || ctx.used === undefined) return
    const u = c.usage ?? emptyTotals()
    const size = ctx.size !== undefined
      ? { contextSize: ctx.size, contextSizeSource: 'log' as const }
      : u.contextSize !== undefined && u.contextSizeSource !== 'table' ? { contextSize: u.contextSize, contextSizeSource: u.contextSizeSource } : tableSize(ctx.model ?? c.modelId)
    this.patchConversation(conversationId, { usage: { ...u, contextUsed: ctx.used, contextSource: 'log', contextSize: undefined, contextSizeSource: undefined, ...size } })
  }

  private onAgentEvent(backendId: string, sessionId: string, event: AgentEvent): void {
    const conversationId = this.bySession.get(`${backendId}:${sessionId}`)
    if (!conversationId) {
      const spare = this.spares.get(backendId)
      if (spare?.sessionId === sessionId && spare.events.length < 50) spare.events.push(event)
      return
    }
    // The agent changed its own options (e.g. left plan mode): show what is in effect now.
    if (event.kind === 'options') {
      const conv = this.store.conversation(conversationId)
      // Typed by the user (Grok's /always-approve off): it is their choice now, and a restart keeps it.
      const typed = event.typed ? event.options.find((o) => o.id === event.typed)?.current : undefined
      this.patchConversation(conversationId, { sessionOptions: event.options, ...(typed !== undefined ? { optionValues: { ...conv?.optionValues, [event.typed!]: typed } } : {}) })
      return
    }
    if (event.kind === 'commands') {
      const name = event.names.find((n) => /^(compact|compress|compaction)$/i.test(n))
      const c = this.store.conversation(conversationId)
      const agentCommands = event.commands ?? event.names.map((n) => ({ name: n }))
      if (c && (c.compactCommand !== name || JSON.stringify(c.agentCommands ?? []) !== JSON.stringify(agentCommands)))
        this.patchConversation(conversationId, { compactCommand: name, agentCommands })
      return
    }
    if (event.kind === 'background') {
      const c = this.store.conversation(conversationId)
      if (!c) return
      const list = [...(c.background ?? [])]
      const i = list.findIndex((b) => b.id === event.id && !b.endedAt)
      if (event.state === 'running' && i < 0)
        list.push({
          id: event.id,
          command: event.command.slice(0, 500),
          startedAt: Date.now(),
          ...(event.title ? { title: event.title.slice(0, 200) } : {}),
          ...(event.managed ? { managed: true } : {}),
          ...(event.monitor ? { monitor: true } : {}),
          ...(event.outputFile ? { outputFile: event.outputFile } : {})
        })
      else if (event.state === 'exited' && i >= 0) {
        // A command that ended within its own reply was a step of it (shown there), not background work.
        if (!list[i].managed && !list[i].detached && this.running.has(conversationId)) list.splice(i, 1)
        else list[i] = { ...list[i], endedAt: Date.now(), exitCode: event.exitCode, ...(event.failed ? { failed: true } : {}), ...(event.output ? { output: event.output.slice(-16_000) } : {}) }
      }
      this.patchConversation(conversationId, { background: list.slice(-BACKGROUND_KEPT) })
      return
    }
    if (event.kind === 'folder') {
      this.hooks.adoptFolder?.(conversationId, event.path)
      return
    }
    if (event.kind === 'compacted') {
      const live = this.live.get(conversationId)
      if (live) live.compacted = true
      return
    }
    if (event.kind === 'usage') {
      const live = this.live.get(conversationId)
      if (event.cost && live) live.cost = event.cost
      // Agents that don't announce compaction (Qoder) still show it: the context they report halves at once.
      if (live && event.contextUsed !== undefined) {
        if (live.contextUsed !== undefined && live.contextUsed >= COMPACTION_FLOOR && event.contextUsed <= live.contextUsed / 2) live.compacted = true
        live.contextUsed = event.contextUsed
      }
      const c = this.store.conversation(conversationId)
      if (c && (event.contextUsed !== undefined || event.contextSize !== undefined)) {
        if (live) live.reported = true
        const u = c.usage ?? emptyTotals()
        const size = event.contextSize !== undefined
          ? { contextSize: event.contextSize, contextSizeSource: 'agent' as const }
          : u.contextSize !== undefined ? { contextSize: u.contextSize, contextSizeSource: u.contextSizeSource } : tableSize(c.modelId)
        this.patchConversation(conversationId, {
          usage: { ...u, contextUsed: event.contextUsed ?? u.contextUsed, contextSource: event.contextUsed !== undefined ? 'agent' : u.contextSource, ...size }
        })
      }
      return
    }
    const reply = this.current.get(conversationId)
    if (!reply) return
    // After 停止 the agent's own words about the cancel ("The request was cancelled by the client.") are not the reply.
    if (this.stopped.has(conversationId) && (event.kind === 'message.delta' || event.kind === 'thought.delta')) return
    this.meters.get(conversationId)?.observe(event)
    // The agent's own task plan (ACP `plan`) is the conversation's live plan too; an empty one withdraws it.
    if (event.kind === 'plan') {
      const conv = this.store.conversation(conversationId)
      if (conv) this.patchConversation(conversationId, { checklist: event.entries.length ? planChecklist(conv.title, event.entries) : undefined, checklistAuto: false })
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

/**
 * A chat's plan that no longer applies once the user writes again: one whose steps are all
 * done (it was for the task just finished), or one another agent made (the chat has since
 * moved to a different backend, which never saw it). A thread's checklist is its status
 * on the project board and stays.
 */
export function stalePlan(conv: Conversation): boolean {
  if (conv.kind !== 'chat' || !conv.checklist) return false
  if (conv.sessionRef && conv.sessionRef.backendId !== conv.backendId) return true
  const steps = conv.checklist.split('\n').map((l) => l.replace(/\*\*/g, '').trim()).filter((l) => /^[✓✱○⊙]/.test(l))
  return steps.length > 0 && steps.every((l) => l.startsWith('✓'))
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
      blocks.push({ type: 'tool', toolId: e.toolId, title: e.title, toolKind: e.toolKind, status: e.status, input: e.input, paths: e.paths })
      break
    case 'tool.update': {
      const t = blocks.find((b): b is Extract<Block, { type: 'tool' }> => b.type === 'tool' && b.toolId === e.toolId)
      if (!t) break
      if (e.title) t.title = e.title
      if (e.status) t.status = e.status
      if (e.output != null) t.output = e.output
      if (e.toolKind) t.toolKind = e.toolKind
      if (e.paths) t.paths = [...new Set([...(t.paths ?? []), ...e.paths])]
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

/** How long opening an agent session may take before the app says so and offers a retry. */
const CONNECT_TIMEOUT = 60_000
/** The reply was stopped before its session opened. */
const STOPPED = Symbol('stopped')

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || 'timeout')), ms)
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    )
  })
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
    .map((m): Line => ({ who: m.role === 'user' ? (m.hidden ? '（内部消息）' : '用户') : '助手', text: cutNote(m) }))
    .filter((l) => l.text)
}

/** Below this many tokens a smaller context is not taken for a compaction. */
/** Commands kept in a conversation's 后台 list. */
const BACKGROUND_KEPT = 12
/** Why a turn ended before the agent was done, by its ACP stop reason. */
const STOPPED_SHORT: Partial<Record<StopReason, string>> = {
  max_tokens: tk('回复达到了长度上限，后面的内容被截断了。'),
  max_turn_requests: tk('达到了轮次上限，回复停在这里。发一条消息可以让它继续。'),
  refusal: tk('模型拒绝回答这个请求。')
}

/** The last `bytes` of a file as text; undefined when it can't be read. */
async function readTail(path: string, bytes: number): Promise<string | undefined> {
  try {
    const f = await open(path, 'r')
    try {
      const { size } = await f.stat()
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - start)
      await f.read(buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      await f.close()
    }
  } catch {
    return undefined
  }
}
const COMPACTION_FLOOR = 20_000

const WITHDRAWN =
  '（应用说明：用户撤回了上一条消息和你对它的回答，那一版已作废，用户看不到了。请只按下面这条消息回答，不要提到撤回。）'

/** A reply that was stopped says so, so the next agent knows where it left off. */
function cutNote(m: Message): string {
  const text = textOf(m)
  if (m.role !== 'assistant' || m.state !== 'cancelled') return text
  return text ? `${text}（这条回复没说完就被中断了）` : '（这条回复刚开始就被中断了）'
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
/** The latest lines of a conversation, whole messages only, up to maxChars (each message capped at perMessage). */
export function excerpt(messages: Message[], maxChars = 3000, perMessage = 800): string {
  const lines = linesOf(messages).map((l) => fmt(l, perMessage))
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0 && used + lines[i].length <= maxChars; i--) {
    out.unshift(lines[i])
    used += lines[i].length + 2
  }
  return out.join('\n\n')
}

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
/** A conversation's context figures, carried over unchanged. */
function contextOf(u: UsageTotals | undefined): Partial<UsageTotals> {
  return u ? { contextUsed: u.contextUsed, contextSize: u.contextSize, contextSource: u.contextSource, contextSizeSource: u.contextSizeSource } : {}
}

/** The window size from the bundled model-limit table, when the model is in it. */
function tableSize(modelId?: string): Partial<UsageTotals> {
  const size = contextLimit(modelId)
  return size ? { contextSize: size, contextSizeSource: 'table' } : {}
}

export function turnUsageOf(result: TurnResult, before: Cost | undefined, after: Cost | undefined): MessageUsage | undefined {
  const u: MessageUsage = { ...(result.usage ?? {}) }
  if (after && after !== before && (!before || before.currency === after.currency)) {
    const amount = after.amount - (before?.amount ?? 0)
    if (amount >= 0) u.cost = { amount, currency: after.currency }
  }
  return Object.keys(u).length ? u : undefined
}
