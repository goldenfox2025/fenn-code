import { rememberRequest, MEMORY_GUIDANCE } from '../memory/memoryRules'
export { rememberRequest } from '../memory/memoryRules'
/**
 * Project orchestration, modelled on Claude Projects:
 *  - the project chat is run by a coordinator agent that answers directly or
 *    starts threads for focused work;
 *  - each thread is run by its own agent, which keeps a status checklist and
 *    reports results in the thread;
 *  - thread activity is folded back into the coordinator's context.
 *
 * Agents get these abilities as tools (served by ToolServer), so this works
 * with any backend whose protocol can pass tools to the agent.
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import type { HostToolServer, TurnResult } from '../../shared/contract'
import { currentBlocker, withBlocker, type Block, type Conversation, type Message, type PeerOutput, type ProgressItem, type ProgressPatch, type Project } from '../../shared/model'
import type { Store } from '../store/Store'
import { ToolRefusal, type ToolDef, type ToolServer } from '../tools/ToolServer'
import { excerpt, fmt, linesOf, textOf, transcript, type ChatService } from './ChatService'
import type { BackendManager } from '../backends/BackendManager'
import type { ProjectMemory } from './ProjectMemory'
import type { ProjectFiles } from './ProjectFiles'
import type { Artifacts } from './Artifacts'
import { uiDocument } from './uiDocument'
import { chartDocument } from './chartDocument'
import type { PeerMail } from './PeerMail'
import { ProjectReviews } from './ProjectReviews'
import { COORDINATOR_ROLE, WORKER_ROLE } from './projectRoles'
import { obj, str } from './tools/args'

export { obj }
import { progressTools } from './tools/progressTools'
import { projectDataTools, type ProjectDataToolDeps } from './tools/projectDataTools'
import { getLang, t } from '../../shared/i18n'

/**
 * When a project agent's session has seen this much, it saves what matters to
 * memory and the next turn starts a fresh session from a handoff. This keeps
 * long-running projects healthy regardless of the backend's context window.
 */
export const HANDOFF_CHARS = 160_000
export const HANDOFF_TURNS = 60
const HANDOFF_RECENT = 30
/** How much conversation goes into one summarization call; longer stretches are summarized in parts. */
const SUMMARY_CHUNK = 60_000
const SUMMARY_MAX = 6000


export class Orchestrator {
  readonly reviews: ProjectReviews
  private reviewWakeups = new Set<string>()
  private reviewScheduled = new Set<string>()
  private isolationRequests = new Map<string, string>()
  /** Handoff thresholds (overridable, e.g. in tests). */
  handoffChars = HANDOFF_CHARS
  handoffTurns = HANDOFF_TURNS

  /** Thread updates waiting to be shown to the coordinator on its next turn. */
  /** Conversations whose agent called memory_write during the current turn. */
  private memoryWritten = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly chat: ChatService,
    private readonly tools: ToolServer,
    private readonly memory: ProjectMemory,
    private readonly files: ProjectFiles,
    private readonly artifacts: Artifacts,
    private readonly backends?: Pick<BackendManager, 'ask' | 'list'>
  ) {
    this.reviews = new ProjectReviews(store, chat)
    this.reviews.onSubmitted = (projectId) => {
      this.reviewWakeups.add(projectId)
      this.wakeReview(projectId)
    }
    this.reviews.onDecided = this.reviews.onSubmitted
    for (const c of store.conversations) if (c.projectId && c.review?.decisionPending) this.reviews.notifyDecision(c.id)
    for (const p of store.projects) if (p.pendingReviewDecisions?.length) this.reviews.onDecided(p.id)
    chat.turnEndListeners.add((id) => {
      const c = store.conversation(id)
      if (c?.projectId && this.reviewWakeups.has(c.projectId)) this.wakeReview(c.projectId)
    })
    chat.removedListeners.add((id) => {
      this.isolationRequests.delete(id)
      this.memoryWritten.delete(id)
      this.lastIndex.delete(id)
    })
    chat.hooks = {
      prepare: (conv) => this.reviews.prepare(conv),
      preamble: (conv, isResume) => this.preamble(conv, isResume),
      instructions: (conv) => this.instructions(conv),
      history: (conv, prior) => this.handoff(conv, prior),
      tools: (conv) => [this.tools.endpoint(conv.id, () => this.toolsFor(conv.id)), ...(this.extraServers?.(conv) ?? [])],
      ownTools: (id) => this.toolsFor(id).map((t) => t.name),
      afterTurn: (conv, reply, result) => this.afterTurn(conv, reply, result),
      beforePrompt: (conv) => this.pendingDigest(conv)
    }
  }

  // ---- prompts ------------------------------------------------------------

  private preamble(conv: Conversation, _isResume: boolean): string {
    const project = this.store.project(conv.projectId)
    const userName = this.store.settings.userName
    const parts: string[] = []
    if (conv.kind === 'project' && project) {
      parts.push(
        `<fenn-context role="coordinator">`,
        `你是 Fenn Code 应用里项目「${project.name}」的协调者。${userName || '用户'}在这个主对话里提需求。`,
        COORDINATOR_ROLE,
        QUIET,
        project.description ? `项目简介：${project.description}` : '',
        this.instructions(conv),
        project.cwd ? `项目工作目录：${project.cwd}` : '',
        this.memorySection(project.id),
        `</fenn-context>`
      )
    } else if (conv.kind === 'thread' && project) {
      parts.push(
        `<fenn-context role="thread">`,
        `你负责项目「${project.name}」的「${conv.title}」讨论串，静默执行本项任务。`,
        WORKER_ROLE,
        conv.workspace ? '代码任务有独立 worktree，勿修改其他 checkout。' : conv.taskKind === 'change' ? '代码任务；此项目无 Git 隔离，先核对实际目录与影响。' : '共用项目上下文。改代码先 request_code_workspace 说明目标并结束回合；应用在原串的独立 worktree 继续。此前不要改共享目录代码。',
        this.instructions(conv),
        conv.cwd ? `${conv.workspace ? '独立工作目录' : '项目共享目录'}：${conv.cwd}` : '',
        this.memorySection(project.id, true),
        `</fenn-context>`
      )
    } else if (project) {
      parts.push(
        `<fenn-context>`,
        `这个对话属于项目「${project.name}」。`,
        PLAN_HINT,
        QUIET,
        this.instructions(conv),
        this.memorySection(project.id),
        `</fenn-context>`
      )
    } else if (conv.kind === 'chat') parts.push(`<fenn-context>`, PLAN_HINT, QUIET, this.instructions(conv), `</fenn-context>`)
    if (parts.length) parts.splice(parts.length - 1, 0, '适合时主动用 render_ui/render_chart。文档、报告、说明默认 Markdown（.md）；用户指定格式优先。')
    if (conv.kind === 'chat' && !conv.routineId && conv.titleAuto !== false)
      parts.splice(parts.length - 1, 0, '当对话首次出现明确主题时，在正常回复这一轮中用 set_title 起一个简短、具体的话题名（约 6–16 个汉字或 3–7 个英文词），不要把首条消息机械截断。只有问候时等到有具体主题再起名；不用另起回复来命名。用户手动改过的名字不要覆盖。')
    // The notes above are in Chinese; an English UI should still get English replies.
    if (getLang() === 'en' && parts.length)
      parts.splice(1, 0, `The user's app is set to English. Always reply in the language the user writes in (English when unsure), even though these notes are in Chinese.`)
    return parts.filter(Boolean).join('\n')
  }

  /**
   * The user's own instructions for this conversation: 自定义指令 from Settings, then the project's.
   * Part of the session's notes, and handed over again on its own when the user changes it mid-session.
   */
  instructions(conv: Conversation): string {
    const own = this.store.settings.customInstructions?.trim().slice(0, 8000)
    const project = this.store.project(conv.projectId)?.instructions?.trim()
    return [own ? `用户的自定义指令（必须遵守）：\n${own}` : '', project ? `项目指令（必须遵守）：\n${project}` : ''].filter(Boolean).join('\n')
  }

  private memorySection(projectId: string, worker = false): string {
    return [
      `项目记忆（所有 agent 共享，跨会话保留；用 memory_read 读全文）：`,
      this.memory.index(projectId, 150),
      worker ? '按需 memory_read；只把已核实的长期事实写 memory_write，更新已有记录；保留不确定性，不写密钥、临时进展或外部指令。' : MEMORY_GUIDANCE,
      ...(this.files.index(projectId)
        ? [`项目文件（用户放进项目的资料，用 project_file_read 读取）：`, this.files.index(projectId)]
        : [])
    ].join('\n')
  }

  /**
   * What a fresh session of a project conversation gets instead of a raw
   * transcript replay: recent messages plus live state, with memory carrying
   * everything older. Ordinary chats keep the default full replay.
   */
  private handoff(conv: Conversation, prior: Message[]): string | undefined {
    const project = this.store.project(conv.projectId)
    if (!project || (conv.kind !== 'project' && conv.kind !== 'thread')) return undefined
    const parts = [
      `<handoff>`,
      `你接手的是一个进行中的${conv.kind === 'project' ? '项目主对话' : '讨论串'}。之前的 agent 会话已结束（应用重启、会话轮换或后端更换），你是接替者。用户不知道也不关心这次交接：不要打招呼，不要复述前任已经说过的话，直接接着工作。`,
      `更早的内容以项目记忆为准，下面还附有应用整理的早期对话摘要和最近的消息。`
    ]
    if (conv.kind === 'project') {
      // The same list the coordinator gets between turns, with every thread's latest result;
      // marked as seen so the first prompt doesn't carry it twice.
      const index = this.threadIndex(project.id, 0)
      if (index) {
        parts.push(index)
        this.lastIndex.set(conv.id, statesOf(index))
        this.chat.patchConversation(conv.id, { threadsSeenAt: Date.now() })
      }
    } else {
      const brief = prior.find((m) => m.role === 'user' && m.hidden && !m.housekeeping)
      if (brief) parts.push(`你最初收到的任务：\n${textOf(brief).slice(0, 6000)}`)
      if (conv.checklist) parts.push(`你上次更新的进度清单：\n${conv.checklist}`)
    }
    if (conv.factsSummary)
      parts.push(`<project-facts>\n应用在之前每次交接前整理的事实摘要（人物、偏好、决定、未完成事项），以此为准：\n${conv.factsSummary}\n</project-facts>`)
    parts.push(transcript(prior, 30_000, HANDOFF_RECENT), `</handoff>`)
    return parts.join('\n\n')
  }

  /** A thread's latest substantive reply, condensed: what the coordinator needs to know it produced. */
  private latestResult(threadId: string, max: number): string {
    const m = [...this.store.messagesOf(threadId)]
      .reverse()
      .find((x) => x.role === 'assistant' && !x.hidden && x.state !== 'streaming' && textOf(x))
    const text = m ? textOf(m).replace(/\s+/g, ' ') : ''
    return text.length > max ? text.slice(0, max) + '……' : text
  }

  /** Conversations whose handoff is being prepared (summary, then save-memory turn). */
  private rotating = new Map<string, Promise<void>>()

  /** Resolves once no handoff is being prepared (for tests). */
  async idle(): Promise<void> {
    while (this.rotating.size) await Promise.all([...this.rotating.values()])
  }

  /**
   * After a long stretch: the app has the backend summarize the facts said so
   * far, then asks the agent to save what matters, then hands off to a fresh
   * session. The summary does not depend on the agent cooperating.
   */
  private maybeRotate(conv: Conversation): void {
    if (conv.kind !== 'project' && conv.kind !== 'thread') return
    if (this.rotating.has(conv.id)) return
    const load = this.chat.sessionLoad(conv.id)
    if (!load || (load.chars < this.handoffChars && load.turns < this.handoffTurns)) return
    const job = (async () => {
      await this.summarize(conv.id).catch((e) => console.warn('[fenn] 交接前整理摘要失败：', e?.message ?? e))
      await this.chat.send(
        conv.id,
        '（系统）这个会话的上下文快满了，接下来会换一个新会话接手。请现在把还没记下、以后仍然需要的信息用 memory_write 存进项目记忆（用户偏好、已做的决定、项目事实、进行中工作的要点）。完成后只回复“好了”。',
        { hidden: true, hiddenReply: true, rotateAfter: true, housekeeping: true }
      )
    })().finally(() => this.rotating.delete(conv.id))
    this.rotating.set(conv.id, job)
  }

  /**
   * Brings a conversation's facts summary up to date: everything said since
   * the last summary goes to the backend with the previous summary, and the
   * merged result replaces it. The coordinator's copy is also kept in project
   * memory so every agent in the project can read it.
   */
  async summarize(conversationId: string): Promise<string | undefined> {
    const conv = this.store.conversation(conversationId)
    if (!conv || !this.backends) return undefined
    const all = this.store.messagesOf(conv.id).filter((m) => m.state !== 'streaming')
    const from = conv.factsThrough ? all.findIndex((m) => m.id === conv.factsThrough) + 1 : 0
    const fresh = all.slice(from)
    const lines = linesOf(fresh).map((l) => fmt(l, 12_000))
    if (!lines.length) return conv.factsSummary
    // Split into parts that fit one call; each part's summary feeds the next.
    const parts: string[][] = [[]]
    let size = 0
    for (const l of lines) {
      if (size + l.length > SUMMARY_CHUNK && parts[parts.length - 1].length) parts.push([]), (size = 0)
      parts[parts.length - 1].push(l)
      size += l.length + 2
    }
    const project = this.store.project(conv.projectId)
    let summary = conv.factsSummary ?? ''
    for (const part of parts) {
      const answer = await this.backends.ask(conv.backendId, summaryPrompt(project?.name ?? '', summary, part.join('\n\n')), {
        timeoutMs: 180_000,
        cwd: conv.cwd ?? project?.cwd
      })
      const next = cleanSummary(answer)
      if (!next) throw new Error('摘要为空')
      summary = next
    }
    this.chat.patchConversation(conv.id, { factsSummary: summary, factsThrough: fresh[fresh.length - 1].id })
    if (conv.kind === 'project' && conv.projectId) {
      this.memory.write(conv.projectId, {
        name: 'project-facts',
        description: '应用在每次交接前自动整理的项目事实摘要：人物与称呼、偏好、决定、未完成事项',
        type: 'project',
        // Memory entries are capped; the conversation keeps the full summary for handoffs.
        body: summary.length > 3900 ? summary.slice(0, 3900) + '…' : summary
      })
    }
    return summary
  }

  /**
   * "记住……" from the user is saved even if the agent didn't save it: the app
   * writes the user's own words to project memory.
   */
  private keepRememberedFact(conv: Conversation, result: TurnResult): void {
    const wrote = this.memoryWritten.delete(conv.id)
    if (wrote || result.stopReason === 'error' || !conv.projectId) return
    if (conv.kind !== 'project' && conv.kind !== 'thread') return
    const asked = [...this.store.messagesOf(conv.id)].reverse().find((m) => m.role === 'user')
    if (!asked || asked.hidden) return
    const text = textOf(asked).trim()
    const fact = rememberRequest(text)
    if (!fact) return
    this.memory.write(conv.projectId, {
      // Named by its content so the user can tell entries apart in the memory list.
      name: fact.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24) || `remembered-${asked.id.slice(0, 8)}`,
      description: fact.replace(/\s+/g, ' ').slice(0, 60),
      type: 'user',
      body: `用户要求记住（原话）：${text.slice(0, 3800)}`
    })
  }

  private pendingDigest(conv: Conversation): string {
    if (conv.kind === 'thread') {
      // Before a thread's turn: an app-written checklist until the agent writes its own.
      const fresh = this.store.conversation(conv.id)
      if (fresh && (!fresh.checklist || fresh.checklistAuto))
        this.chat.patchConversation(conv.id, { checklist: `${fresh.title}\n\n✱ ${t('正在处理')}`, checklistAuto: true })
    }
    if (conv.kind === 'chat' && !conv.parentId) return this.childDigest(conv)
    if (conv.kind !== 'project' || !conv.projectId) return ''
    // The coordinator gets the list of threads as it is now, only when it changed since it last
    // saw it, with the results that came in meanwhile: one snapshot, not a pile of notices.
    const seen = this.store.conversation(conv.id)?.threadsSeenAt ?? 0
    const index = this.threadIndex(conv.projectId, seen)
    const states = statesOf(index)
    this.chat.patchConversation(conv.id, { threadsSeenAt: Date.now() })
    if (!index || (states === this.lastIndex.get(conv.id) && states === index)) return ''
    this.lastIndex.set(conv.id, states)
    return index
  }

  /** A chat's sub-conversations as they are now, before its turn, only when that changed (the same snapshot rule as threads). */
  private childDigest(conv: Conversation): string {
    const children = this.childrenOf(conv.id)
    if (!children.length) return ''
    const seen = this.store.conversation(conv.id)?.threadsSeenAt ?? 0
    const index = this.listIndex(children, seen, 'subconversations', '子对话')
    const states = statesOf(index)
    this.chat.patchConversation(conv.id, { threadsSeenAt: Date.now() })
    if (states === this.lastIndex.get(conv.id)) return ''
    this.lastIndex.set(conv.id, states)
    return index
  }

  private childrenOf(id: string): Conversation[] {
    return this.store.conversations.filter((c) => c.parentId === id).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** What the coordinator was last shown, so an unchanged list isn't repeated (memory only). */
  private lastIndex = new Map<string, string>()

  /** Each thread's state in a line; threads that changed since `since` also carry their latest result. */
  private threadIndex(projectId: string, since = Infinity): string {
    return this.listIndex(this.threadsOf(projectId), since, 'threads', '讨论串')
  }

  private listIndex(all: Conversation[], since: number, tag: string, noun: string): string {
    if (!all.length) return ''
    const open = all.filter((t) => !t.resolved)
    const done = all.filter((t) => t.resolved).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)
    const stateOf = (t: Conversation) => {
      if (t.resolved) return '已解决'
      if (t.review?.state === 'pending') return `待验收 revision:${t.review.id}，${t.review.recommendation?.verdict ?? '待主对话审核'}`
      if (t.review?.state === 'stale') return '交付已变化，需重新提交验收'
      if (this.awaitsDecision(t.id)) return '等用户决定'
      const blocker = t.blockers?.filter((b) => !b.resolvedAt).pop()
      if (blocker) return `卡住：${blocker.text.slice(0, 80)}`
      if (t.status === 'working') return '进行中'
      if (t.status === 'error') return '出错'
      return '等用户回复'
    }
    let fresh = 0
    const row = (t: Conversation) => {
      const step = !t.resolved && t.status === 'working' ? t.checklist?.split('\n').find((l) => l.trim().startsWith('✱'))?.replace(/\*\*/g, '').trim() : undefined
      const line = `- 「${t.title}」 id:${t.id.slice(0, 8)} ${stateOf(t)}${step ? `，当前：${step.replace(/^✱\s*/, '')}` : ''}`
      if (t.updatedAt <= since || t.status === 'working' || fresh >= 8) return line
      const result = this.latestResult(t.id, 200)
      if (!result) return line
      fresh++
      return `${line}\n  最新结果：${result}`
    }
    return [
      `<${tag}>`,
      open.length ? `未解决的${noun}：\n${open.map(row).join('\n')}` : `没有未解决的${noun}。`,
      done.length ? `最近解决的：\n${done.map(row).join('\n')}` : '',
      `</${tag}>`
    ].filter(Boolean).join('\n')
  }

  /** The thread's latest reply asks the user to choose and nobody has yet. */
  private awaitsDecision(threadId: string): boolean {
    const last = [...this.store.messagesOf(threadId)].reverse().find((m) => !m.hidden && m.role !== 'system')
    return !!last && last.role === 'assistant' && last.blocks.some((b) => b.type === 'decision' && b.chosen === undefined)
  }

  // ---- after each turn ----------------------------------------------------

  private afterTurn(conv: Conversation, reply: Message, result: TurnResult): void {
    this.keepRememberedFact(conv, result)
    this.maybeRotate(conv)
    if (conv.kind === 'thread') {
      // Agents that never call update_status still get a checklist the user can read.
      const fresh = this.store.conversation(conv.id)
      if (fresh?.checklistAuto)
        this.chat.patchConversation(conv.id, {
          checklist: `${fresh.title}\n\n${result.stopReason === 'error' ? `✱ ${t('出错了，等您查看')}` : `**✓ ${t('已回复，等您查看')}**`}`
        })
    }
    if (conv.kind !== 'thread' || !conv.projectId) return
    const isolation = this.isolationRequests.get(conv.id)
    if (isolation && result.stopReason !== 'error') {
      this.isolationRequests.delete(conv.id)
      this.chat.patchConversation(conv.id, { taskKind: 'change', isolateWorkspace: true })
      this.chat.rotate(conv.id)
      void this.chat.send(conv.id, `已转为代码修改任务。应用将在本回合开始前为本串准备独立 worktree；检查当前工作目录后继续，不要修改项目集成目录。需求与交接说明：\n${isolation}`, { hidden: true })
      return
    }
    const fresh = this.store.conversation(conv.id)!
    // A thread that finished its turn is waiting on the user unless resolved; one that stopped
    // on an obstacle it reported needs them in person.
    if (result.stopReason !== 'error' && fresh.status === 'idle') {
      const stuck = !fresh.resolved && !fresh.needsUser ? currentBlocker(fresh) : undefined
      this.chat.patchConversation(conv.id, { status: fresh.resolved ? 'done' : 'waiting', ...(stuck ? { needsUser: { kind: 'blocked', text: stuck.text, at: Date.now() } } : {}) })
    }
    // Touch the project so it sorts as recently active.
    const p = this.store.project(conv.projectId)
    if (p) this.store.putProject({ ...p, updatedAt: Date.now() })
    if (fresh.review?.state === 'pending' && result.stopReason !== 'error') this.reviews.notify(fresh.id)
  }

  /** Coalesce simultaneous deliveries; never interrupt the coordinator or wake it for its own review. */
  private wakeReview(projectId: string): void {
    const p = this.store.project(projectId)
    if (!p || this.reviewScheduled.has(projectId) || this.chat.isBusy(p.conversationId)) return
    this.reviewScheduled.add(projectId)
    const timer = setTimeout(() => {
      this.reviewScheduled.delete(projectId)
      if (this.chat.isBusy(p.conversationId)) return
      this.reviewWakeups.delete(projectId)
      const pending = this.threadsOf(projectId).filter((c) => c.review?.state === 'pending' && !c.review.recommendation)
      const decisions = (this.store.project(projectId)?.pendingReviewDecisions ?? []).slice(0, 8)
      if (!pending.length && !decisions.length) return
      const notice = decisions.map((d) => ({ thread_id: d.threadId, title: d.title, revision: d.revision, decision: d.decision, kind: d.kind, feedback: d.feedback, continuation: d.continuation, merge_commit: d.mergeCommit, integration_plan: d.integrationPlan }))
      const messages = [
        pending.length ? `应用通知：有讨论串等待验收。逐项 inspect_delivery，核对需求、实际 diff、交叉修改和验证证据。用 review_delivery 记录意见：summary 是一句话建议；notes 用 Markdown 分段解释判断、结构与影响、验证局限和下一步。代码交付还必须填写 integration_plan，说明如何合入、依赖和冲突、行为影响、合入后检查及回退方式。finding 只评估证据，不合并实验代码。用户最终决定；卡片已有分析，不重复全文。\n${pending.map((c) => `${c.title} thread_id:${c.id} revision:${c.review!.id}`).join('\n')}` : '',
        decisions.length ? `应用通知：用户已作出验收决定。以下是应用已记录的结果：\n${JSON.stringify(notice)}\n批准的代码已由应用执行安全合入，不要重复合并；简要说明实际结果、影响和后续检查。采纳分析不表示合并代码。退回必须纳入项目进展；continuation=thread 表示该串按反馈继续，continuation=main 表示先在主对话解释方案、需要时向用户提问，尚未让子串自动改动。discussion 是用户意见，不代表批准、拒绝或让子串执行；先分析和回应，需要补改时由你判断是否明确调用 message_thread，等新版本提交后再验收。用户可在主对话或原串继续讨论。` : ''
      ]
      const jobs: Promise<void>[] = []
      if (messages[0]) jobs.push(this.chat.send(p.conversationId, messages[0], { hidden: true, hiddenReply: true, tag: 'project-review' }))
      if (messages[1]) jobs.push(this.chat.send(p.conversationId, messages[1], { hidden: true, tag: 'project-decision' }))
      void Promise.all(jobs).then(() => {
        if (this.store.conversation(p.conversationId)?.status === 'error') { this.reviewWakeups.add(projectId); return }
        const project = this.store.project(projectId)
        if (project && decisions.length) {
          const ids = new Set(decisions.map((d) => d.id))
          const remaining = project.pendingReviewDecisions?.filter((d) => !ids.has(d.id)) ?? []
          this.store.putProject({ ...project, pendingReviewDecisions: remaining.length ? remaining : undefined })
          if (remaining.length) this.reviews.onDecided?.(projectId)
        }
        for (const d of decisions) {
          const current = this.store.conversation(d.threadId)?.review
          if (current?.id === d.revision && current.decidedAt === d.at) this.chat.patchConversation(d.threadId, { review: { ...current, decisionPending: false } })
        }
      }).catch(() => { this.reviewWakeups.add(projectId) })
    }, 400)
    timer.unref?.()
  }


  // ---- threads ------------------------------------------------------------

  /**
   * Moves a request the coordinator answered inline into a thread: the user's
   * words become the thread's task, with the coordinator's answer as context.
   * The app does this itself, so it works with models that never call start_thread.
   */
  convertToThread(conversationId: string, messageId: string): Conversation | undefined {
    const conv = this.store.conversation(conversationId)
    const project = this.store.project(conv?.projectId)
    if (!conv || conv.kind !== 'project' || !project) return undefined
    const list = this.store.messagesOf(conv.id)
    const at = list.findIndex((m) => m.id === messageId)
    if (at < 0) return undefined
    const reply = list[at].role === 'assistant' ? list[at] : undefined
    const asked = list.slice(0, at + 1).reverse().find((m) => m.role === 'user' && !m.hidden)
    if (!asked) return undefined
    const request = textOf(asked)
    const answer = reply ? textOf(reply) : ''
    const instructions = [
      `用户原话：${request}`,
      answer ? `协调者已经在主对话里给出的初步回答（可以在此基础上继续，不必重复）：\n${answer.slice(0, 4000)}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    return this.startThread(project, titleFrom(request), instructions, undefined, reply ?? asked)
  }

  startThread(project: Project, title: string, instructions: string, ack?: string, anchorMessage?: Message, kind: 'change' | 'finding' = 'finding'): Conversation {
    const coordinatorConv = project.conversationId
    // The card goes on the coordinator's in-progress reply (or the last message).
    const anchor = anchorMessage ?? this.chat.currentReply(coordinatorConv) ?? this.lastMessage(coordinatorConv)
    const thread = this.chat.createConversation({
      kind: 'thread',
      title,
      projectId: project.id,
      anchorMessageId: anchor?.id,
      backendId: this.pickBackend?.(project.backendId) ?? project.backendId,
      cwd: project.cwd,
      taskKind: kind,
      isolateWorkspace: kind === 'change'
    })
    if (anchor) {
      anchor.blocks.push({ type: 'thread-card', threadId: thread.id })
      this.chat.updateMessage(anchor)
    }
    if (ack) this.chat.addMessage(thread.id, 'assistant', [{ type: 'text', text: ack }])
    // Work handed off from an unattended run (a scheduled task) is unattended too.
    void this.chat.send(thread.id, `协调者交给你的任务：\n${instructions}`, {
      hidden: true,
      unattended: this.chat.isUnattended(coordinatorConv) || undefined
    })
    return thread
  }

  private lastMessage(conversationId: string): Message | undefined {
    const list = this.store.messagesOf(conversationId).filter((m) => !m.hidden)
    return list[list.length - 1]
  }

  private threadsOf(projectId: string): Conversation[] {
    return this.store.conversations.filter((c) => c.projectId === projectId && c.kind === 'thread')
  }

  private findThread(projectId: string, ref: unknown): Conversation {
    const id = str(ref, 'thread_id')
    const t = this.threadsOf(projectId).find((c) => c.id === id || c.id.startsWith(id) || c.title === id)
    if (!t) throw new Error(`找不到讨论串 ${id}，先用 list_threads 查看`)
    return t
  }

  // ---- tools --------------------------------------------------------------

  /** Adds or changes one item on a project's progress board (set by AppCore, which owns projects). */
  progress?: (projectId: string, patch: ProgressPatch, by: 'agent' | 'app') => ProgressItem


  /** Set by the core: the installed backend a new thread should use, given the project's. */
  pickBackend?: (preferred?: string) => string

  /** Called when a project's library of outputs changes. */
  onProjectChanged?: (p: Project) => void
  /** Puts a result card under the reply being written, and into the project's library. */
  private get dataToolDeps(): ProjectDataToolDeps {
    return { files: this.files, memory: this.memory, attachOutput: (id, o) => this.attachOutput(id, o), wroteMemory: (id) => void this.memoryWritten.add(id) }
  }

  private attachOutput(conversationId: string, o: { kind: 'file' | 'link'; title: string; path?: string; url?: string; size?: number }): void {
    const reply = this.chat.currentReply(conversationId)
    if (!reply) throw new Error('只能在回复过程中使用')
    const same = (b: Block) => b.type === 'output' && (b.path ?? b.url) === (o.path ?? o.url)
    reply.blocks = reply.blocks.filter((b) => !same(b))
    reply.blocks.push({ type: 'output', ...o })
    this.chat.updateMessage(reply)
    const conv = this.store.conversation(conversationId)
    const p = this.store.project(conv?.projectId)
    if (!p) return
    const outputs = (p.outputs ?? []).filter((x) => !((x.path ?? x.url) === (o.path ?? o.url) && x.conversationId === conversationId))
    outputs.push({ id: randomUUID(), ...o, conversationId, messageId: reply.id, at: Date.now() })
    const next = { ...p, outputs: outputs.slice(-300), updatedAt: Date.now() }
    this.store.putProject(next)
    this.onProjectChanged?.(next)
  }


  /** The user's connectors (other MCP servers), added to every session. */
  extraServers?: (conv: Conversation) => HostToolServer[]

  /** Tools contributed from outside the orchestrator (e.g. computer control). */
  extraTools?: (conv: Conversation) => ToolDef[]

  /** Set by AppCore: messages between threads. */
  peers?: PeerMail

  private leaveMessage(from: Conversation, to: Conversation, text: unknown, deliver: unknown, outputs: unknown) {
    if (!this.peers) throw new Error('留言不可用')
    const when = deliver === 'now' || deliver === 'when_idle' || deliver === 'after_current_task' ? deliver : undefined
    if (deliver !== undefined && !when) throw new Error('deliver 只能是 now、when_idle 或 after_current_task')
    const refs = outputs === undefined ? [] : (Array.isArray(outputs) ? outputs : [outputs]).map((x) => (typeof x === 'string' ? x : String((x as { title?: string })?.title ?? x)))
    const { message, existing } = this.peers.send(from, to, str(text, 'text'), when, this.resolveOutputs(from, refs))
    const n = message.outputs?.length ?? 0
    if (existing) return `一样的留言已经${message.state === 'pending' ? '在等着送达' : '送到了'}，没有重复发。`
    if (message.state !== 'pending') return `已送达「${to.title}」${n ? `，附 ${n} 个产物` : ''}。`
    const when2 = message.deliver === 'now' ? '马上送达（它正在回复时排在这一轮之后）' : message.deliver === 'when_idle' ? '等它空闲时送达' : '等它当前任务做完后送达'
    return `已给「${to.title}」留言${n ? `，附 ${n} 个产物` : ''}，${when2}。用户在两个讨论串里都能看到。`
  }

  /** Finds what a thread has handed over by title, file name, path or link. */
  private resolveOutputs(from: Conversation, refs: string[]): PeerOutput[] {
    if (!refs.length) return []
    const project = this.store.project(from.projectId)
    const own = (project?.outputs ?? []).filter((o) => o.conversationId === from.id)
    const others = (project?.outputs ?? []).filter((o) => o.conversationId !== from.id)
    const files = project ? this.files.list(project.id) : []
    const pages = this.artifacts.list().filter((a) => a.conversationId === from.id)
    const key = (v?: string) => (v ?? '').trim().toLowerCase()
    const found: PeerOutput[] = []
    const missing: string[] = []
    for (const ref of refs) {
      const k = key(ref)
      const out = [...own, ...others].find((o) => [o.title, o.path, o.url, o.path && basename(o.path)].some((v) => key(v || '') === k))
      const file = files.find((f) => key(f.name) === k || key(f.path) === k)
      const page = pages.find((a) => key(a.title) === k || key(a.id) === k)
      const o: PeerOutput | undefined = out
        ? { kind: out.kind, title: out.title, path: out.path, url: out.url }
        : file
          ? { kind: 'file', title: file.name, path: file.path }
          : page
            ? { kind: 'page', title: page.title, pageId: page.id, path: this.artifacts.file(page.id) }
            : undefined
      if (!o) missing.push(ref)
      else if (!found.some((x) => (x.path ?? x.url ?? x.pageId) === (o.path ?? o.url ?? o.pageId))) found.push(o)
    }
    if (missing.length) {
      const known = [...own.map((o) => o.title), ...files.map((f) => f.name), ...pages.map((a) => a.title)]
      throw new Error(`找不到这些产物：${missing.join('、')}。${known.length ? `可以附上的有：${[...new Set(known)].slice(0, 30).join('、')}` : '你还没有交付过产物：先用 project_file_write 写进项目文件，或用 attach_output 附上。'}`)
    }
    return found
  }

  private toolsFor(conversationId: string): ToolDef[] {
    const conv = this.store.conversation(conversationId)
    if (!conv) return []
    const tools = [...this.baseTools(conv), ...(this.extraTools?.(conv) ?? [])]
    // A thread does one task: tools for running the project (board, routines, memory upkeep, naming) stay with the coordinator.
    return conv.kind === 'thread' ? tools.filter((t) => !THREAD_LEAVES.has(t.name)) : tools
  }

  /** Running sub-conversations one chat may have at a time. */
  static readonly MAX_RUNNING_SUBCHATS = 5

  /**
   * Hands focused side work to a new conversation in the same folder, on the
   * same agent. It is a hand-off: afterwards the user talks to the new
   * conversation directly, and it never reports back here.
   */
  startSubconversation(parent: Conversation, title: string, task: string, context?: string): Conversation {
    if (parent.kind !== 'chat' || parent.parentId) throw new Error('只有普通对话能开子对话，子对话里不能再开')
    if (parent.routineId || this.chat.isUnattended(parent.id)) throw new Error('定时任务无人值守，不能开子对话')
    const running = this.store.conversations.filter((c) => c.parentId === parent.id && (c.status === 'working' || c.status === 'waiting')).length
    if (running >= Orchestrator.MAX_RUNNING_SUBCHATS) throw new ToolRefusal(`已有 ${running} 个子对话在进行，先等它们完成`)
    const by = this.backends?.list().find((b) => b.id === parent.backendId)?.name ?? parent.backendId
    const child = this.chat.createConversation({
      kind: 'chat',
      title: title.trim().slice(0, 60) || titleFrom(task),
      parentId: parent.id,
      handoff: { by, task, context: context?.trim() || undefined },
      backendId: parent.backendId,
      modelId: parent.modelId,
      cwd: parent.cwd
    })
    const anchor = this.chat.currentReply(parent.id) ?? this.lastMessage(parent.id)
    if (anchor) {
      anchor.blocks.push({ type: 'thread-card', threadId: child.id })
      this.chat.updateMessage(anchor)
    }
    const brief = [
      `这是从另一个对话交接过来的任务，现在由你在这个新对话里负责。直接开始做；之后用户会在这里直接和你沟通，不需要向原来的对话汇报。`,
      `任务：\n${task}`,
      context?.trim() ? `上下文：\n${context.trim()}` : ''
    ].filter(Boolean).join('\n\n')
    void this.chat.send(child.id, brief, { hidden: true })
    return child
  }

  private baseTools(conv: Conversation): ToolDef[] {
    const conversationId = conv.id
    const project = this.store.project(conv.projectId)
    const common: ToolDef[] = []
    common.push(
      {
        name: 'update_status',
        description:
          '更新顶部计划，传完整清单：首行任务名，空行后每行用 ✓ 完成、✱ 进行中、○ 未开始。多步骤任务开头、完成步骤、耗时工作前或计划变化时更新；写 3–6 个业务里程碑和实际结果，不列“回复用户”“等你选择”等界面步骤。简单问答不用。',
        inputSchema: obj({ text: { type: 'string' } }, ['text']),
        aliases: { text: ['checklist', 'status', 'steps', 'content', 'progress', 'plan', 'items'] },
        example: { text: '整理竞品定价\n\n✓ 找到三家竞品\n✱ 对比价格\n○ 写结论' },
        run: ({ text }) => {
          const now = this.store.conversation(conversationId)
          this.chat.patchConversation(conversationId, { checklist: normalizeChecklist(str(text, 'text'), now?.title ?? conv.title), checklistAuto: false })
          return 'ok'
        }
      },
      {
        name: 'set_blocker',
        description:
          '记录当前难点，新的会进入历史；解决传空字符串。',
        inputSchema: obj({ text: { type: 'string', description: '当前难点，解决留空' } }, ['text']),
        aliases: { text: ['blocker', 'problem', 'issue', 'difficulty', 'content'] },
        example: { text: '登录接口返回 403，正在确认是不是代理的问题' },
        run: ({ text }) => {
          const now = this.store.conversation(conversationId)
          if (!now) return 'ok'
          this.chat.patchConversation(conversationId, { blockers: withBlocker(now, typeof text === 'string' ? text : '') })
          return 'ok'
        }
      }
    )
    if (conv.kind === 'chat' && !conv.parentId && !conv.routineId && !this.chat.isUnattended(conversationId))
      common.push({
        name: 'start_subconversation',
        description:
          '对话推进到需要专门处理的一块旁支工作时（例如一个独立的排查、重构或调研），或用户要求开子对话时，把它交给一个新的子对话：同一个文件夹、同一个 agent，并立刻开始做。之后用户直接到子对话里和它沟通，你不能给它发消息；它的最新状态会在你下一轮开头以 <subconversations> 给你，也可以用 check_subconversations 查看。task 要写清楚目标、限制和怎样算完成；context 放子对话需要知道的背景（它看不到这里的对话）。子对话里不能再开子对话。',
        inputSchema: obj(
          {
            title: { type: 'string', description: '子对话的标题，几个字' },
            task: { type: 'string', description: '交给子对话的任务：目标、限制、完成标准' },
            context: { type: 'string', description: '可选：子对话需要的背景（它看不到这里的对话）' }
          },
          ['title', 'task']
        ),
        aliases: { task: ['brief', 'instructions', 'prompt'], title: ['name'] },
        example: { title: '降低图片压缩脚本的 CPU 占用', task: '在 resize.py 里把主循环的轮询从 0.2 秒改成按需，量出改动前后的 CPU，不要重启服务。' },
        run: ({ title, task, context }) => {
          const now = this.store.conversation(conversationId)
          if (!now) throw new Error('对话已不存在')
          const child = this.startSubconversation(now, typeof title === 'string' ? title : '', str(task, 'task'), typeof context === 'string' ? context : undefined)
          return `已开启子对话「${child.title}」，它已经开始工作。用户会直接在那里和它沟通。`
        }
      })
    if (conv.kind === 'chat' && conv.parentId)
      common.push({
        name: 'read_parent_conversation',
        description: '读开出你的主对话（只读）。不带参数：最近的内容；带 query：包含这个词的消息。交接给你的背景不够时用。',
        inputSchema: obj({ query: { type: 'string', description: '可选：要找的词' } }, []),
        aliases: { query: ['search', 'keyword', 'q'] },
        run: ({ query }) => {
          const parent = this.store.conversation(conv.parentId!)
          if (!parent) return '主对话已不存在。'
          const list = this.store.messagesOf(parent.id).filter((m) => !m.hidden)
          const q = typeof query === 'string' ? query.trim() : ''
          if (!q) return excerpt(list, 12_000, 2_000) || '主对话里还没有内容。'
          const hits = list.filter((m) => textOf(m).includes(q)).slice(-10)
          return hits.length ? excerpt(hits, 12_000, 1_200) : `主对话里没有包含「${q}」的消息。`
        }
      })
    if (conv.kind === 'chat' && !conv.parentId && this.childrenOf(conversationId).length)
      common.push({
        name: 'check_subconversations',
        description: '查看这个对话开出的子对话现在的状态和最新结果（只读，不会打扰它们）。',
        inputSchema: obj({}, []),
        run: () => this.listIndex(this.childrenOf(conversationId), 0, 'subconversations', '子对话') || '没有子对话。'
      })
    common.push({
      name: 'ask_decision',
      description:
        '需要用户拍板时（改变目标、用户会注意到的结果、不可撤销的操作）发一张选择卡：一个问题，2 到 4 个选项，各附一句后果，推荐一个。卡片不阻塞：能继续就按推荐方案继续，不可撤销的步骤等用户选。不要在回复里重复问题。',
      inputSchema: obj(
        {
          question: { type: 'string', description: '问题，动词开头，十几个字' },
          context: { type: 'string', description: '可选的背景说明' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: obj({ label: { type: 'string' }, consequence: { type: 'string' } }, ['label', 'consequence'])
          },
          recommended: { type: 'integer', description: '推荐选项的序号，从 0 开始' }
        },
        ['question', 'options', 'recommended']
      ),
      run: ({ question, context, options, recommended }) => {
        const reply = this.chat.currentReply(conversationId)
        if (!reply) throw new Error('只能在回复过程中使用')
        const opts = (Array.isArray(options) ? options : [])
          .slice(0, 4)
          .map((o: any) => ({ label: String(o?.label ?? '').slice(0, 40), consequence: String(o?.consequence ?? '').slice(0, 200) }))
          .filter((o) => o.label)
        if (opts.length < 2) throw new Error('至少需要两个选项')
        const rec = Math.min(Math.max(0, Number(recommended) || 0), opts.length - 1)
        reply.blocks.push({
          type: 'decision',
          question: str(question, 'question').slice(0, 300),
          context: context ? String(context).slice(0, 1200) : undefined,
          options: opts,
          recommended: rec
        })
        this.chat.updateMessage(reply)
        const at = Date.now()
        this.chat.patchConversation(conversationId, { needsUser: { kind: 'decision', text: str(question, 'question').slice(0, 300), at } })
        // A thread waiting on the user says so in the project chat, outside every agent's context.
        if (conv.kind === 'thread' && project)
          this.chat.addMessage(project.conversationId, 'system', [{ type: 'thread-event', threadId: conv.id, kind: 'decision', text: str(question, 'question').slice(0, 300), at }])
        return '卡片已发给用户。用户选择后会以一条消息告诉你。'
      }
    })
    common.push({
      name: 'correct_message',
      description:
        '就地更正你之前回复里说错的地方：原文划掉，后面跟「更正：…」。不发新消息，不通知用户。',
      inputSchema: obj(
        {
          wrong: { type: 'string', description: '之前回复里说错的原文，一字不差（一句或一段）' },
          correction: { type: 'string', description: '一句话的更正' }
        },
        ['wrong', 'correction']
      ),
      aliases: { wrong: ['old', 'original', 'text', 'old_text'], correction: ['fix', 'note', 'new', 'new_text'] },
      example: { wrong: '这个接口不需要登录。', correction: '需要登录，未登录时返回 401。' },
      run: ({ wrong, correction }) => {
        const bad = str(wrong, 'wrong').trim()
        const fix = str(correction, 'correction').trim().replace(/^更正[：:]\s*/, '')
        const current = this.chat.currentReply(conversationId)?.id
        const earlier = this.store
          .messagesOf(conversationId)
          .filter((m) => m.role === 'assistant' && !m.hidden && m.id !== current)
          .reverse()
        for (const m of earlier) {
          const i = m.blocks.findIndex((b) => b.type === 'text' && b.text.includes(bad))
          if (i < 0) continue
          const b = m.blocks[i] as Extract<Block, { type: 'text' }>
          const at = b.text.lastIndexOf(bad)
          const blocks = [...m.blocks]
          blocks[i] = { ...b, text: `${b.text.slice(0, at)}~~${bad}~~ [${t('更正：{0}', fix)}]${b.text.slice(at + bad.length)}` }
          this.chat.updateMessage({ ...m, blocks, editedAt: Date.now() })
          return '已在原消息里更正，没有通知用户。'
        }
        throw new Error('在你之前的回复里找不到这段原文。wrong 要和原文一字不差，而且只能更正你自己之前的回复。')
      }
    })
    common.push({
      name: 'attach_output',
      description:
        '把交付给用户的成果（本机文件路径，或 https 链接）附在这条回复下面，显示成卡片。结果是文件或链接时用它交付，不要只在文字里写路径。',
      inputSchema: obj(
        {
          path: { type: 'string', description: '文件路径（和 url 二选一）' },
          url: { type: 'string', description: 'https 链接（和 path 二选一）' },
          title: { type: 'string', description: '卡片上显示的名字（可选）' }
        },
        []
      ),
      aliases: { path: ['file', 'file_path', 'filepath'], url: ['link', 'href'], title: ['name'] },
      run: ({ path, url, title }) => {
        if (typeof url === 'string' && url.trim()) {
          const u = url.trim()
          if (!/^https?:\/\/[^\s]+$/.test(u)) throw new Error('url 必须是 http(s) 链接')
          const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : u.replace(/^https?:\/\//, '').slice(0, 80)
          this.attachOutput(conversationId, { kind: 'link', title: name, url: u })
          return '链接卡片已附上。'
        }
        const raw = str(path, 'path').replace(/^~(?=$|[\\/])/, homedir())
        const base = conv.cwd || project?.cwd
        const full = isAbsolute(raw) ? raw : base ? resolvePath(base, raw) : ''
        if (!full) throw new Error('相对路径需要工作文件夹；请给出绝对路径')
        let st
        try {
          st = statSync(full)
        } catch {
          throw new Error(`找不到文件：${full}`)
        }
        if (!st.isFile()) throw new Error(`不是文件：${full}`)
        const name = typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : basename(full)
        this.attachOutput(conversationId, { kind: 'file', title: name, path: full, size: st.size })
        return '文件卡片已附上。'
      }
    })
    // UI, charts and pages share the same artifact storage and presentation.
    for (const mode of ['ui', 'chart', 'page']) {
      const embedded = mode !== 'page'
      const chart = mode === 'chart'
      common.push({
        name: chart ? 'render_chart' : embedded ? 'render_ui' : 'publish_page',
        description: chart
          ? '回复内统计图：line 折线、bar 柱状，labels 对应各系列 values，缺失值 null。支持悬停数值、图例切换、键盘查看，离线自适应主题。source 标明依据或示例/估算；禁止虚构。page_id 更新，默认 inline。'
          : embedded
          ? '回复内交互 UI，统计图优先 render_chart。html 是 HTML/CSS/SVG/JS 片段，无需整页标签、背景或标题栏。按内容长高；禁止固定外层宽高/100vh；网格用 minmax(0,1fr)，窄窗改单列。标题、阈值标注独立占行，不用负偏移叠字。主题变量：--text、--text-2、--text-3、--bg、--bg-elevated、--border、--accent、--accent-fg。控件可键盘操作。数据标明依据/估算。默认 inline，可选 panel；page_id 更新。沙箱不能访问应用、本地文件或网络。'
          : '发布完整 HTML 网页，默认 panel。回复内交互控件用 render_ui，统计图用 render_chart；page_id 更新。CSS/JS 内联，外部脚本仅限 HTTPS。',
        inputSchema: obj(
          {
            title: { type: 'string' },
            ...(chart ? {
              type: { type: 'string', enum: ['line', 'bar'] },
              labels: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string' } },
              series: { type: 'array', minItems: 1, maxItems: 10, items: obj({ name: { type: 'string' }, values: { type: 'array', items: { type: ['number', 'null'] } } }, ['name', 'values']) },
              unit: { type: 'string', description: '数值单位（可选）' },
              source: { type: 'string', description: '数据依据，或明确标注示例/估算（可选）' }
            } : { html: { type: 'string', description: embedded ? '嵌入对话的 HTML/CSS/SVG/JS 片段，不是完整网页' : '完整的 HTML 文档' } }),
            page_id: { type: 'string' },
            display: { type: 'string', enum: ['inline', 'panel'], description: embedded ? '默认 inline：正文内直接使用；panel：明确需要侧栏时使用' : '默认 panel：独立网页' }
          },
          chart ? ['title', 'type', 'labels', 'series'] : ['title', 'html']
        ),
        run: (args) => {
          const { title, html, page_id, display } = args
          const reply = this.chat.currentReply(conversationId)
          if (!reply) throw new Error('只能在回复过程中使用')
          const source = String(html ?? '')
          const { meta, version } = this.artifacts.publish(
            conversationId,
            String(title ?? '').slice(0, 60),
            chart ? chartDocument(args) : embedded ? uiDocument(source) : source,
            page_id ? String(page_id) : undefined
          )
          const placement = display === 'inline' ? 'inline' : display === 'panel' ? 'panel' : embedded ? 'inline' : 'panel'
          reply.blocks.push({ type: 'artifact', artifactId: meta.id, title: meta.title, version, display: placement })
          this.chat.updateMessage(reply)
          return { page_id: meta.id, version, display: placement }
        }
      })
    }
    if (conv.kind === 'chat' && !conv.routineId) common.push({
      name: 'set_title',
      description: '为普通对话自动起一个简短、具体的话题名。在首次有明确主题的正常回复里调用，不要机械截断用户原话。手动设置的名字会被保留。',
      inputSchema: obj({ title: { type: 'string' } }, ['title']),
      aliases: { title: ['name', 'text'] },
      run: ({ title }) => {
        const current = this.store.requireConversation(conv.id)
        if (current.titleAuto === false) return { kept: true, title: current.title }
        const name = [...str(title, 'title').trim().replace(/\s+/g, ' ')].slice(0, 120).join('')
        if (!name) throw new Error('标题不能为空')
        this.chat.patchConversation(conv.id, { title: name, titleAuto: true })
        return { title: name }
      }
    })
    if (!project) return common
    common.push(...projectDataTools(this.dataToolDeps, project.id, conv.id), ...progressTools({ store: this.store, progress: this.progress }, project.id, conv))

    if (conv.kind === 'project') {
      return [
        ...common,
        {
          name: 'inspect_delivery',
          description: '检查当前交付版本：真实 Git diff、重叠路径、集成冲突、工作者测试声明和未验证项。只能读取，不能批准。',
          inputSchema: obj({ thread_id: { type: 'string' }, revision: { type: 'string' } }, ['thread_id', 'revision']),
          run: ({ thread_id, revision }) => this.reviews.inspect(this.findThread(project.id, thread_id).id, str(revision, 'revision'))
        },
        {
          name: 'review_delivery',
          description: '记录主对话意见。summary 是简短建议；notes 用 Markdown 解释原因、代码结构或证据、验证局限和下一步，不能堆终端输出。ready 供用户决定，不是批准。',
          inputSchema: obj({ thread_id: { type: 'string' }, revision: { type: 'string' }, verdict: { type: 'string', enum: ['ready', 'changes_requested', 'needs_discussion'] }, notes: { type: 'string' }, summary: { type: 'string' }, integration_plan: { type: 'string', description: '代码合入方式、依赖与冲突、行为影响、合入后验证和回退方式；代码交付必须说明' } }, ['thread_id', 'revision', 'verdict', 'notes']),
          run: ({ thread_id, revision, verdict, notes, summary, integration_plan }) => {
            if (verdict !== 'ready' && verdict !== 'changes_requested' && verdict !== 'needs_discussion') throw new Error('Invalid verdict')
            return this.reviews.recommend(this.findThread(project.id, thread_id).id, str(revision, 'revision'), verdict, str(notes, 'notes'), typeof summary === 'string' ? summary : undefined, typeof integration_plan === 'string' ? integration_plan : undefined)
          }
        },
        {
          name: 'start_thread',
          description:
            '为一项定义明确的工作开一个讨论串，由独立的 agent 在讨论串里静默完成。返回 thread_id。instructions 是交给讨论串的完整需求：用户原话、目标和怎样算做完、项目里相关的已知信息、你在分叉处选的默认方案。',
          inputSchema: obj(
            {
              title: { type: 'string', description: '讨论串标题：几个字的名词短语，用用户的说法，不是句子' },
              instructions: { type: 'string', description: '交给讨论串 agent 的完整任务说明' },
              ack: { type: 'string', description: '讨论串里的第一句话，说明先做什么（可选）' },
              new_anyway: { type: 'boolean', description: '已有同名的已解决讨论串、但这确实是新目标时传 true（可选）' },
              kind: { type: 'string', enum: ['change', 'finding'], description: '默认 finding：共用项目上下文做调研/分析/排查。需要修改代码时选 change，应用为该串创建独立 worktree。' }
            },
            ['instructions']
          ),
          aliases: { instructions: ['task', 'prompt', 'description', 'content', 'message', 'request', 'details'], title: ['name', 'subject', 'topic'] },
          example: { title: '竞品定价调研', instructions: '用户原话：帮我调研三家竞品的定价。默认先看官网公开价格。' },
          run: ({ title, instructions, ack, new_anyway, kind }) => {
            const task = str(instructions, 'instructions')
            const name = typeof title === 'string' && title.trim() ? title.trim() : titleFrom(task)
            // One thread per goal: a thread with the same title gets the follow-up instead of a twin.
            const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
            const same = this.threadsOf(project.id).filter((x) => key(x.title) === key(name))
            const open = same.find((x) => !x.resolved)
            if (open)
              return { existing_thread_id: open.id, title: open.title, note: '已有同名的未解决讨论串，没有新开。请用 message_thread 把需求发过去。' }
            const done = same[0]
            if (done && new_anyway !== true)
              return { existing_thread_id: done.id, title: done.title, note: '已有同名的已解决讨论串。是同一件事就用 message_thread 发过去（会自动重新打开）；确实是新目标就换个标题，或带 new_anyway:true 再调用一次。' }
            const t = this.startThread(project, name, task, typeof ack === 'string' ? ack : undefined, undefined, kind === 'change' ? 'change' : 'finding')
            return { thread_id: t.id, title: t.title }
          }
        },
        {
          name: 'message_thread',
          description: '把一条补充说明或用户的追问转给某个讨论串的 agent。默认立即送达；要等它当前任务做完或空闲时再送，传 deliver（after_current_task / when_idle），可以用 outputs 附上已有的产物。',
          inputSchema: obj({ thread_id: { type: 'string' }, text: { type: 'string' }, ...PEER_FIELDS }, ['thread_id', 'text']),
          aliases: { thread_id: ['thread', 'id', 'threadid', 'title', 'to'], text: ['message', 'content', 'note'], deliver: ['when', 'condition'], outputs: ['attachments', 'files'] },
          example: { thread_id: '3f2a9c1e', text: '用户补充：预算控制在 5 万以内。' },
          run: ({ thread_id, text, deliver, outputs }) => {
            const t = this.findThread(project.id, thread_id)
            if ((deliver !== undefined && deliver !== 'now') || (Array.isArray(outputs) && outputs.length))
              return this.leaveMessage(conv, t, text, deliver ?? 'now', outputs)
            if (t.resolved) this.chat.patchConversation(t.id, { resolved: false })
            void this.chat.send(t.id, `协调者转来的消息：\n${str(text, 'text')}`, {
              hidden: true,
              unattended: this.chat.isUnattended(conversationId) || undefined
            })
            // Mark the user's message as sent on to the thread, as Claude Projects does.
            const asked = [...this.store.messagesOf(conversationId)].reverse().find((m) => m.role === 'user' && !m.hidden)
            if (asked && !asked.forwardedTo) {
              asked.forwardedTo = t.id
              this.chat.updateMessage(asked)
            }
            return 'delivered'
          }
        },
        {
          name: 'list_threads',
          description: '列出项目里所有讨论串：id、标题、状态、进度清单当前步骤、最后回复摘要。',
          inputSchema: obj({}, []),
          run: () =>
            this.threadsOf(project.id).map((t) => ({
              thread_id: t.id,
              title: t.title,
              status: t.resolved ? 'resolved' : t.status,
              current_step: t.checklist?.split('\n').find((l) => l.trim().startsWith('✱'))?.replace(/\*\*/g, ''),
              last_reply: t.lastPreview,
              review: t.review ? { ...t.review, assessment: t.review.assessment ? { ...t.review.assessment, diff: undefined } : undefined } : undefined,
              workspace: t.workspace
            }))
        },
        {
          name: 'read_thread',
          description: '读取某个讨论串最近的消息。',
          inputSchema: obj({ thread_id: { type: 'string' }, limit: { type: 'number' } }, ['thread_id']),
          aliases: { thread_id: ['thread', 'id', 'title'] },
          run: ({ thread_id, limit }) => {
            const t = this.findThread(project.id, thread_id)
            const n = typeof limit === 'number' ? Math.min(Math.max(1, limit), 50) : 12
            return this.store
              .messagesOf(t.id)
              .filter((m) => !m.hidden)
              .slice(-n)
              .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${textOf(m).slice(0, 2000)}`)
              .join('\n\n')
          }
        },
        {
          name: 'set_thread_resolved',
          description: '把讨论串标记为已解决（工作完成、没人欠下一步）或重新打开。',
          inputSchema: obj({ thread_id: { type: 'string' }, resolved: { type: 'boolean' } }, ['thread_id']),
          aliases: { thread_id: ['thread', 'id', 'title'], resolved: ['done', 'value'] },
          run: ({ thread_id, resolved }) => {
            const thread = this.findThread(project.id, thread_id)
            const r = resolved !== false
            if (r) return this.reviews.submit(thread.id, this.latestResult(thread.id, 4000) || thread.title, '', t('旧版完成工具未提供测试证据，请主对话核验。'))
            this.chat.patchConversation(thread.id, { resolved: r, status: r ? 'done' : 'waiting' })
            return 'ok'
          }
        }
      ]
    }

    if (conv.kind === 'thread') {
      return [
        ...common,
          {
            name: 'request_code_workspace',
            description: '申请把本串转为代码任务。调用后结束回合，应用在独立工作区继续。',
            inputSchema: obj({ reason: { type: 'string' } }, ['reason']),
            run: ({ reason }) => {
              if (this.store.requireConversation(conv.id).isolateWorkspace) return { ready: true, isolated: !!this.store.requireConversation(conv.id).workspace, cwd: this.store.requireConversation(conv.id).cwd }
              this.isolationRequests.set(conv.id, str(reason, 'reason'))
              return { queued: true, instruction: '结束本回合。应用将在独立工作区继续同一讨论串。' }
            }
          },
        {
          name: 'submit_review',
          description: '提交摘要、检查记录和未验证项供验收。代码先提交到本串分支。',
          inputSchema: obj({ summary: { type: 'string' }, checks: { type: 'string' }, unverified: { type: 'string' }, kind: { type: 'string', enum: ['change', 'finding'] } }, ['summary']),
          run: ({ summary, checks, unverified, kind }) => this.reviews.submit(conv.id, str(summary, 'summary'), typeof checks === 'string' ? checks : '', typeof unverified === 'string' ? unverified : '', kind === 'finding' ? 'finding' : kind === 'change' ? 'change' : undefined)
        },
        {
          name: 'message_thread',
          description:
            '给同项目的串留言。deliver 默认等任务结束，也可选空闲或立即排队。outputs 附已有产物标题或文件名。',
          inputSchema: obj({ thread_id: { type: 'string', description: '对方讨论串的 id 或标题（见 list_threads）' }, text: { type: 'string', description: '要对方做什么，写清楚' }, ...PEER_FIELDS }, ['thread_id', 'text']),
          aliases: { thread_id: ['thread', 'id', 'threadid', 'title', 'to', 'target'], text: ['message', 'content', 'note', 'task'], deliver: ['when', 'condition'], outputs: ['attachments', 'files', 'artifacts'] },
          example: { thread_id: '竞品定价调研', text: '调研做完后，请根据我整理的「方案草稿.md」给出新的定价方案。', outputs: ['方案草稿.md'], deliver: 'after_current_task' },
          run: ({ thread_id, text, deliver, outputs }) => {
            const now = this.store.conversation(conv.id)
            if (!now) throw new Error('讨论串已不存在')
            return this.leaveMessage(now, this.findThread(project.id, thread_id), text, deliver ?? 'after_current_task', outputs)
          }
        },
        {
          name: 'list_threads',
          description: '列出项目里的其他讨论串：id、标题、状态、当前步骤。',
          inputSchema: obj({}, []),
          run: () =>
            this.threadsOf(project.id).filter((t) => t.id !== conv.id).map((t) => ({
              thread_id: t.id,
              title: t.title,
              status: t.resolved ? 'resolved' : t.status,
              current_step: t.checklist?.split('\n').find((l) => l.trim().startsWith('✱'))?.replace(/\*\*/g, '')
            }))
        },
        {
          name: 'set_title',
          description: '修改本讨论串的标题。',
          inputSchema: obj({ title: { type: 'string' } }, ['title']),
          aliases: { title: ['name', 'text'] },
          run: ({ title }) => {
            this.chat.patchConversation(conv.id, { title: str(title, 'title') })
            return 'ok'
          }
        }
      ]
    }
    return common
  }
}

const PEER_FIELDS = {
  deliver: { type: 'string', enum: ['after_current_task', 'when_idle', 'now'], description: '送达时机' },
  outputs: { type: 'array', items: { type: 'string' }, description: '要附上的已交付产物：标题、项目文件名或页面标题（可选）' }
}

/** How ordinary chats keep the user posted on longer work. */
/** Cards, status and the working mark already acknowledge a message; text is for results. */
/** Tools a thread doesn't get: they run the project, which is the coordinator's job. */
const THREAD_LEAVES = new Set(['set_title', 'memory_list', 'memory_delete', 'progress_read', 'progress_update', 'create_routine', 'list_routines', 'delete_routine', 'publish_page'])

const QUIET =
  '不要写“收到”“好的，我先……”这类回执，也不要在调用工具前预告要做什么：界面会自动显示你在工作。每条用户消息只回一次，开头就是结果或需要用户做的事。'

const PLAN_HINT =
  '做多步骤的任务时，用 update_status 写任务计划并随进度更新；卡在难点上时用 set_blocker 写一句，遇到新难点再写，解决了清掉。简单问答不需要这些。'


function summaryPrompt(projectName: string, previous: string, conversation: string): string {
  return [
    `<<summarize>>`,
    `你是 Fenn Code 应用的后台整理助手，不和用户对话，也不调用任何工具。下面是项目「${projectName}」里的一段对话，和此前已经整理好的事实摘要。`,
    `请输出合并后的完整事实摘要，供以后接手的 agent 使用。要求：`,
    `- 分成这几节：人物与称呼、偏好与要求、决定、项目事实、未完成事项。每条一行，以“- ”开头。`,
    `- 只写对话里明确说过、以后仍然成立的事实：谁是谁（人名、客户名、项目的各种叫法）、用户的偏好和对回复方式的要求（原文是英文的保留英文原句）、做过的决定（包括否定的选项）、名字、数字、日期、链接。`,
    `- 新内容和旧摘要冲突时以新内容为准；旧摘要里仍然成立的条目必须保留。`,
    `- 不写寒暄、过程和重复的讨论。不编造。总长不超过 ${SUMMARY_MAX} 字。`,
    `- 只输出摘要本身，不要前言和结尾。`,
    `<previous-summary>\n${previous || '（还没有）'}\n</previous-summary>`,
    `<conversation>\n${conversation}\n</conversation>`
  ].join('\n')
}

/** The summary text from a backend's answer, or '' when it is unusable. */
function cleanSummary(answer: string): string {
  let s = answer.trim().replace(/^```[a-z]*\n?|```$/g, '').trim()
  s = s.replace(/^<\/?(previous-summary|summary|project-facts)>\s*|\s*<\/?(previous-summary|summary|project-facts)>$/g, '').trim()
  if (s.length < 4) return ''
  return s.length > SUMMARY_MAX * 1.5 ? s.slice(0, SUMMARY_MAX * 1.5) + '…' : s
}

/** A short thread title from its task: the first clause, a few words. */
export function titleFrom(task: string): string {
  const first = task.replace(/^(用户原话|用户说|任务|需求)[:：]\s*/, '').split(/[\n。！？!?；;，,]/)[0].trim()
  return (first.length > 16 ? first.slice(0, 16) + '…' : first) || '新的讨论串'
}

/**
 * A checklist in the app's format whatever the model sent: a title line, a
 * blank line, then ✓ / ✱ / ○ steps. Markdown checkboxes and plain list items
 * are converted; plain items count as not started.
 */
export function normalizeChecklist(text: string, fallbackTitle: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const DONE = /^(\[[xX]\]|✓|✔|✅)\s*/
  const DOING = /^(\[[~>-]\]|✱|⏳|🔄|▶)\s*/
  const TODO = /^(\[ ?\]|○|☐|◯|⬜)\s*/
  const BULLET = /^([-*+•]|\d+[.)、])\s+/
  const steps: string[] = []
  let title = ''
  for (const raw of lines) {
    let l = raw
    const bold = /^\*\*(.+)\*\*$/.exec(l)
    if (bold) l = bold[1].trim()
    const bulleted = BULLET.test(l)
    l = l.replace(BULLET, '')
    let sym = ''
    for (const [re, mark] of [[DONE, '✓'], [DOING, '✱'], [TODO, '○']] as const) {
      if (re.test(l)) {
        sym = mark
        l = l.replace(re, '')
        break
      }
    }
    if (!sym && !bulleted && !title && !steps.length) {
      title = l.replace(/^#+\s*/, '')
      continue
    }
    const line = `${sym || '○'} ${l}`
    steps.push(bold && sym === '✓' ? `**${line}**` : line)
  }
  return [title || fallbackTitle, '', ...steps].join('\n')
}

/** A thread list without its result lines: what changed in state, not in output. */
function statesOf(index: string): string {
  return index
    .split('\n')
    .filter((l) => !l.startsWith('  最新结果'))
    .join('\n')
}
