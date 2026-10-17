/**
 * App domain model: projects, conversations, messages, routines.
 * Shared by main (source of truth) and renderer (view). Backend-agnostic.
 */
import type { GenerationTiming, MessageUsage, UsageTotals } from './usage'
import type { AccountStatus, BackendSummary, CreditQuota, ModelInfo, PermissionDecision, PermissionRequest, SessionOption, ToolStatus } from './contract'

export interface Attachment {
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'file'
  /** base64, for images */
  data?: string
  /** contents, for text files */
  text?: string
  path?: string
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'attachment'; attachment: Attachment }
  /** startedAt/ms: when thinking began and how long it took, for 「思考了 4 秒」. */
  | { type: 'thought'; text: string; startedAt?: number; ms?: number }
  | { type: 'tool'; toolId: string; title: string; toolKind?: string; status: ToolStatus; input?: string; output?: string }
  | { type: 'plan'; entries: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string; key?: string }
  /** The chat was given this folder because the agent made files (「已放在 …」). */
  | { type: 'placed'; path: string }
  /** In a project chat: the card of a thread started from this message. */
  | { type: 'thread-card'; threadId: string }
  /**
   * In a project chat, shown to the user only (never to an agent): a thread needs their decision,
   * or the user sent a message straight to a thread with @.
   */
  | { type: 'thread-event'; threadId: string; kind: 'decision' | 'forwarded'; text: string; /** For a decision: matches the thread's needsUser.at while it is still open. */ at?: number }
  /** A message between two threads of a project (see PeerMessage): sent from here, or delivered here. */
  | { type: 'peer-message'; peerId: string; direction: 'out' | 'in' }
  /** A result the agent handed over: a file on this computer or a link. Shown as a card under the reply. */
  | { type: 'output'; kind: 'file' | 'link'; title: string; path?: string; url?: string; size?: number }
  /** A page the agent published (see Artifacts); opens beside the conversation. */
  | { type: 'artifact'; artifactId: string; title: string; version: number }
  /** A question for the user with a few options, one recommended; `chosen` once answered. */
  | {
      type: 'decision'
      question: string
      context?: string
      options: { label: string; consequence: string }[]
      recommended: number
      chosen?: number
    }

export type MessageRole = 'user' | 'assistant' | 'system'

/** Whether a search query is long enough to run (a single CJK character counts). */
export const searchable = (q: string): boolean => {
  const t = q.trim()
  return t.length >= 2 || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(t)
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  blocks: Block[]
  createdAt: number
  /** 'streaming' while the agent is still producing it. */
  state?: 'streaming' | 'done' | 'error' | 'cancelled'
  /** Cut off because the app quit mid-reply (not stopped by the user). */
  interrupted?: boolean
  /** Cut off because the user switched to this agent mid-reply (its name). */
  switchedTo?: string
  error?: string
  reactions?: string[]
  /** Hidden from the transcript (e.g. relayed notes delivered to an agent). */
  hidden?: boolean
  /**
   * App bookkeeping with the agent (save-memory before a handoff, resume after
   * a restart): never shown, and never replayed to a later session.
   */
  housekeeping?: boolean
  /** In a project chat: the thread this message was passed on to. */
  forwardedTo?: string
  /**
   * A user message that was edited or answered again: which version of that
   * turn this is. Older versions (with what followed them) are kept aside and
   * can be switched back to.
   */
  variant?: { group: string; index: number; count: number }
  /** The agent corrected this reply in place later (see the correct_message tool). */
  editedAt?: number
  /** Replies: the tokens (and cost) the backend reported for this turn; absent when it reported none. */
  usage?: MessageUsage
  timing?: GenerationTiming
}

export type ConversationKind = 'chat' | 'project' | 'thread'
export type WorkStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error'

export interface Conversation {
  id: string
  kind: ConversationKind
  title: string
  projectId?: string
  /** For threads: the project-chat message the thread hangs under. */
  anchorMessageId?: string
  /** Created by this routine's run. */
  routineId?: string
  /** A sub-conversation: the chat whose agent started it. The two never talk afterwards. */
  parentId?: string
  /** What the parent's agent handed over when it started this sub-conversation. */
  handoff?: { by: string; task: string; context?: string }
  /** cwd is a folder the app made for this chat once it made files; listed with folderless chats. */
  autoFolder?: boolean
  backendId: string
  modelId?: string
  models?: ModelInfo[]
  /** The session's other choices (mode, thinking level…), as the agent last reported them. */
  sessionOptions?: SessionOption[]
  /** What the user chose for those options in this conversation. */
  optionValues?: Record<string, string>
  cwd?: string
  createdAt: number
  updatedAt: number
  status: WorkStatus
  /** Task plan (✓ / ✱ / ○ lines): written by the agent (update_status or its own ACP plan), or by the app for threads. */
  checklist?: string
  /** Obstacles the agent reported, oldest first; the last one without resolvedAt is the current one. */
  blockers?: Blocker[]
  /** The title was made by the app (not typed by the user), so it may be improved later. */
  titleAuto?: boolean
  /** The app already offered this finished thread for the project's progress board. */
  progressSuggested?: boolean
  /** The checklist was written by the app because the agent never called update_status. */
  checklistAuto?: boolean
  resolved?: boolean
  pinned?: boolean
  /** Messages the user has not seen yet. */
  unread?: boolean
  lastPreview?: string
  /** The backend session this conversation last used, for resuming after a restart. */
  sessionRef?: { backendId: string; sessionId: string }
  /** Visible messages in the conversation. */
  messageCount?: number
  /** Tokens and cost the backend reported, added up over every turn (hidden ones included). */
  usage?: UsageTotals
  /** Latest visible reply, separate from cumulative usage. Old replies are not backfilled. */
  timing?: GenerationTiming
  /**
   * Project conversations: a running summary of the facts said so far
   * (people, preferences, decisions, open items), written by the backend
   * before each handoff and merged with the previous one.
   */
  factsSummary?: string
  /** The last message factsSummary covers. */
  factsThrough?: string
  /**
   * The agent needs the user in person: a decision card, a permission prompt, or
   * a thread that stopped stuck. Cleared once the user answers or writes. This,
   * not text in the reply, decides which notifications a project's level lets through.
   */
  needsUser?: { kind: 'decision' | 'permission' | 'blocked'; text?: string; at: number }
  /** Project chats: when the coordinator last saw the list of threads (see Orchestrator.threadIndex). */
  threadsSeenAt?: number
}

export interface Project {
  id: string
  name: string
  description?: string
  /** Standing instructions every agent in the project receives. */
  instructions?: string
  cwd?: string
  backendId: string
  /** The project chat (coordinator conversation). */
  conversationId: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  icon?: string
  /** Put away: hidden from the sidebar and the main project list, kept intact. */
  archived?: boolean
  /** The project's progress board: milestones, each with optional tasks. */
  progress?: ProgressItem[]
  /** Which desktop notifications the project raises (default 'coordinator'). */
  notify?: NotifyLevel
  /** Results agents handed over in this project's conversations, newest last (the project's library). */
  outputs?: ProjectOutput[]
}

/** When a message one thread leaves for another is delivered. */
export type PeerDelivery = 'now' | 'when_idle' | 'after_current_task'

/** Something a thread hands over with a message: a result card, a project file, or a page. */
export interface PeerOutput {
  kind: 'file' | 'link' | 'page'
  title: string
  path?: string
  url?: string
  pageId?: string
}

/**
 * A message one project thread (or the project chat) leaves for another thread,
 * delivered when its condition is met. Kept across restarts.
 */
export interface PeerMessage {
  id: string
  projectId: string
  fromId: string
  toId: string
  text: string
  outputs?: PeerOutput[]
  deliver: PeerDelivery
  /** 1 for a message sent in a turn the user started; one more for each message-triggered turn. */
  hop: number
  /** Threads the chain has already passed through, oldest first (the sender included). */
  chain: string[]
  state: 'pending' | 'delivered' | 'cancelled' | 'failed'
  /** Why it was not delivered. */
  reason?: string
  createdAt: number
  deliveredAt?: number
}

/**
 * A project's notifications, as in Claude: every new message (each thread's
 * replies too); the project chat plus whatever needs the user (the default);
 * only what needs the user; or nothing.
 */
export type NotifyLevel = 'all' | 'coordinator' | 'mentions' | 'none'

export interface ProjectOutput {
  id: string
  kind: 'file' | 'link'
  title: string
  path?: string
  url?: string
  size?: number
  conversationId: string
  messageId: string
  at: number
}

export type ProgressStatus = 'todo' | 'doing' | 'blocked' | 'done'

/** A milestone (top level) or a task under one. */
export interface ProgressItem {
  id: string
  title: string
  status: ProgressStatus
  /** YYYY-MM-DD */
  due?: string
  note?: string
  /** Threads or chats that did (or are doing) the work. */
  links?: string[]
  /** Tasks under a milestone (one level deep). */
  children?: ProgressItem[]
  /** Proposed by the app from finished work; shown for the user to keep or dismiss. */
  suggested?: boolean
  /** Who last changed it. */
  by?: 'user' | 'agent' | 'app'
  createdAt: number
  updatedAt: number
}

/** What the user or an agent sends to add or change one progress item. */
export interface ProgressPatch {
  /** Existing item to change; omitted to add one. */
  id?: string
  /** Milestone to add a new task under. */
  parentId?: string
  title?: string
  status?: ProgressStatus
  /** '' clears it. */
  due?: string
  note?: string
  /** Conversation ids to link (added to existing links). */
  link?: string[]
  suggested?: boolean
}

export type Schedule =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string /* HH:MM */; weekdays?: number[] /* 0=Sun */ }
  | { kind: 'cron'; expr: string }

export interface Routine {
  id: string
  name: string
  prompt: string
  schedule: Schedule
  /** Where results land: a project chat, an existing conversation, or a new chat each run. */
  target: { projectId?: string; conversationId?: string }
  backendId?: string
  enabled: boolean
  /** The conversation whose agent created it, if an agent did. */
  createdBy?: string
  /** Paused because its project was archived; restoring the project turns it back on. */
  pausedByArchive?: boolean
  createdAt: number
  lastRunAt?: number
  lastRunConversationId?: string
  lastError?: string
  nextRunAt?: number
}

export interface MemoryEntry {
  name: string
  description: string
  type: string
  body: string
  updatedAt: number
}

export interface Blocker {
  text: string
  at: number
  resolvedAt?: number
}

/** The obstacle the agent is working on now, if any. */
export function currentBlocker(c: Pick<Conversation, 'blockers'>): Blocker | undefined {
  const last = c.blockers?.[c.blockers.length - 1]
  return last && !last.resolvedAt ? last : undefined
}

/** A plan's steps: the one in progress, and how many are done. */
export function planProgress(checklist?: string): { step?: string; done: number; total: number } | undefined {
  const steps = (checklist ?? '').split('\n').map((l) => l.replace(/\*\*/g, '').trim()).filter((l) => /^[✓✱○]/.test(l))
  if (!steps.length) return undefined
  const step = steps.find((l) => l.startsWith('✱'))?.replace(/^✱\s*/, '')
  return { step, done: steps.filter((l) => l.startsWith('✓')).length, total: steps.length }
}

/** Records a new obstacle (closing the previous one), or with an empty text, clears the current one. */
export function withBlocker(c: Pick<Conversation, 'blockers'>, text: string, now = Date.now()): Blocker[] {
  const list = (c.blockers ?? []).map((b) => (b.resolvedAt ? b : { ...b, resolvedAt: now }))
  const t = text.trim()
  if (t && t !== currentBlocker(c)?.text) list.push({ text: t.slice(0, 200), at: now })
  else if (t) return c.blockers ?? []
  return list.slice(-12)
}

export interface BackendModelCatalog {
  models: ModelInfo[]
  current?: string
  options?: SessionOption[]
  /** The agent wouldn't open a session because it isn't signed in; no models until it is. */
  needsLogin?: boolean
}

export interface AppSettings {
  defaultBackendId: string
  /** Secrets that couldn't be carried over from an old app name and have to be entered again. */
  secretsToReenter?: string[]
  /** The app name the one-time repair of secrets saved under old names last ran for. */
  secretsRepairedFor?: string
  /** Color scheme; 'system' follows the OS. ('glass' is the pre-0.1.1 setting, read as dark + glass.) */
  theme: 'system' | 'light' | 'dark' | 'glass'
  /** The frosted glass look, layered over the color scheme. */
  glass?: boolean
  /** Diagnostics: write every ACP message to logs/ in the data folder. Off by default. */
  acpDebugLog?: boolean
  /** UI language (Settings → 通用); 'system' follows the OS. */
  language?: 'system' | 'zh' | 'en'
  userName: string
  notifications?: boolean
  /** Keep running in the tray after the window closes (Windows/Linux). */
  runInBackground?: boolean
  /** Lets agents see the screen and use the mouse and keyboard (asks per conversation). */
  computerUse?: boolean
  defaultCwd?: string
  /** The first-run guide has been finished or skipped. */
  onboarded?: boolean
  /**
   * Models each backend offered last time, with the one a new session starts on,
   * so a new chat can show and pick a model before its first message.
   */
  backendModels?: Record<string, BackendModelCatalog>
  /** The model the user last chose for each backend, independent of its advertised default. */
  backendModelDefaults?: Record<string, string>
  /** User-pinned agents retain their explicit order in the searchable picker. */
  favoriteBackendIds?: string[]
  /** Option choices (by backend, then option id) that new conversations start with. */
  backendOptionDefaults?: Record<string, Record<string, string>>
  /** Model-specific choices override the backend fallback when switching back. */
  backendModelOptionDefaults?: Record<string, Record<string, Record<string, string>>>
  /** Working folders the user chose, newest first. */
  recentFolders?: string[]
  /** Where a chat that makes files gets its own folder; Documents/Ancora when unset. */
  autoFolderRoot?: string
}

export interface AppInfo {
  name: string
  version: string
  /** Short git commit the build came from, if known. */
  commit?: string
  builtAt?: string
  electron?: string
  chrome?: string
  node?: string
  platform: string
  arch: string
  /** The window can blur the desktop behind it (macOS vibrancy, Windows 11 acrylic). */
  nativeGlass?: boolean
  /** No GPU compositing: expensive effects like backdrop blur are skipped. */
  softwareRendering?: boolean
}

export type UpdateCheck =
  | { status: 'latest'; version: string }
  | { status: 'available'; version: string; url?: string; notes?: string }
  | { status: 'unconfigured' }
  | { status: 'error'; message: string }

export interface AppSnapshot {
  projects: Project[]
  conversations: Conversation[]
  routines: Routine[]
  settings: AppSettings
  backends: BackendSummary[]
  platform: string
  peerMessages?: PeerMessage[]
}

/** Pushed from main to renderer. */
export type AppEvent =
  | { type: 'project'; project: Project }
  | { type: 'project-removed'; id: string }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversation-removed'; id: string }
  | { type: 'message'; message: Message }
  | { type: 'message-removed'; conversationId: string; id: string }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine-removed'; id: string }
  | { type: 'peer-message'; message: PeerMessage }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'backends'; backends: BackendSummary[] }
  | { type: 'permission'; conversationId?: string; request: PermissionRequest }
  | { type: 'permission-resolved'; requestId: string }
  | { type: 'toast'; level: 'info' | 'error'; text: string }
  | { type: 'open-conversation'; conversationId: string }
  /** Output of a backend upgrade as it runs. */
  | { type: 'backend-upgrade'; backendId: string; line: string }

/** A tool server (MCP) the user adds once; every agent session gets it, whatever the backend. */
export interface Connector {
  id: string
  name: string
  enabled: boolean
  kind: 'command' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** Environment variables (command) or request headers (http). Never sent to the UI. */
  secrets?: Record<string, string>
}

/** What the UI sees of a connector: secret values stay in the main process. */
export type ConnectorView = Omit<Connector, 'secrets'> & { secretKeys: string[] }

export interface SearchHit {
  conversationId: string
  messageId: string
  role: 'user' | 'assistant'
  createdAt: number
  snippet: string
}

/** A folder the app thinks the user may want to work in. */
export interface FolderCandidate {
  path: string
  name: string
  /** Last change to the folder itself, as a rough "recently worked on". */
  mtime: number
}

export interface NewChatOptions {
  backendId?: string
  projectId?: string
  /** Working folder; '' for none, omitted for the project's or the default one. */
  cwd?: string
  /** Model to start on (from the backend's remembered model list). */
  modelId?: string
  /** Session options for this chat only (e.g. a permission mode chosen before sending). */
  optionValues?: Record<string, string>
  text: string
  attachments?: Attachment[]
}

/** The API the renderer sees as window.ancora. */
export interface AncoraApi {
  snapshot(): Promise<AppSnapshot>
  messages(conversationId: string): Promise<Message[]>
  onEvent(listener: (e: AppEvent) => void): () => void

  startChat(opts: NewChatOptions): Promise<Conversation>
  send(conversationId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** From the project chat: hands the user's message straight to one of its threads (@ in the composer). */
  sendToThread(projectConversationId: string, threadId: string, text: string, attachments?: Attachment[]): Promise<void>
  /** Drops the last reply and asks again. */
  regenerate(conversationId: string): Promise<void>
  /** Replaces a user message (and everything after it) with an edited version. */
  editMessage(conversationId: string, messageId: string, text: string): Promise<void>
  /** Shows version `index` of an edited or regenerated turn. */
  switchVariant(conversationId: string, group: string, index: number): Promise<void>
  cancel(conversationId: string): Promise<void>
  setModel(conversationId: string, modelId: string): Promise<void>
  /** Sets a session option (e.g. the mode) for one conversation. */
  setOption(conversationId: string, optionId: string, value: string): Promise<void>
  /** Sets what new conversations on a backend start with. */
  setOptionDefault(backendId: string, optionId: string, value: string, modelId?: string): Promise<void>
  setModelDefault(backendId: string, modelId: string): Promise<void>
  /** Whether the user is signed in to a backend, if it can tell. */
  backendAccount(backendId: string): Promise<AccountStatus>
  backendCredits(backendId: string, refresh?: boolean): Promise<CreditQuota | undefined>
  /** Opens the conversation's agent session in the background, before the first message. Sends nothing. */
  prepareConversation(conversationId: string): Promise<void>
  /** Opens the folder the ACP debug log is written to. */
  openLogFolder(): Promise<void>
  /** Reads the agent's session metadata without sending a prompt or creating a chat. */
  backendModels(backendId: string, modelId?: string): Promise<BackendModelCatalog>
  backendLatestVersion(backendId: string): Promise<string | undefined>
  /** Per backend: can its model look at images (and so control the computer)? undefined until it has started. */
  backendImages(): Promise<Record<string, boolean | undefined>>
  /** Opens a result file with its default app (documents, images, text), or shows it in its folder. */
  openOutput(path: string, reveal?: boolean): Promise<{ ok: boolean; error?: string }>
  /** Runs the backend's upgrade command; output arrives as 'backend-upgrade' events. */
  upgradeBackend(backendId: string): Promise<{ ok: boolean; output: string; account: AccountStatus; /** Installed, but the program still isn't on PATH. */ notFound?: boolean }>
  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'pinned' | 'resolved' | 'projectId' | 'unread' | 'cwd' | 'backendId'>>): Promise<void>
  deleteConversation(id: string): Promise<void>
  react(messageId: string, conversationId: string, emoji: string): Promise<void>

  createProject(p: { name: string; description?: string; instructions?: string; cwd?: string; backendId?: string }): Promise<Project>
  updateProject(id: string, patch: Partial<Omit<Project, 'id' | 'conversationId' | 'createdAt'>>): Promise<void>
  deleteProject(id: string): Promise<void>

  saveRoutine(r: Omit<Routine, 'id' | 'createdAt'> & { id?: string }): Promise<Routine>
  deleteRoutine(id: string): Promise<void>
  runRoutineNow(id: string): Promise<void>

  listMemory(projectId: string): Promise<MemoryEntry[]>
  saveMemory(projectId: string, e: { name: string; description: string; type?: string; body: string }): Promise<void>
  deleteMemory(projectId: string, name: string): Promise<void>
  search(query: string): Promise<SearchHit[]>
  artifactInfo(id: string): Promise<{ id: string; title: string; versions: { version: number; createdAt: number }[] } | null>
  artifactSource(id: string, version?: number): Promise<string | null>
  /** Withdraws a message one thread left for another, while it still waits. */
  cancelPeerMessage(id: string): Promise<void>
  /** Answers a decision card: records the choice and sends it to the agent. */
  chooseDecision(conversationId: string, messageId: string, blockIndex: number, option: number): Promise<void>
  listConnectors(): Promise<ConnectorView[]>
  /** secrets: new values to set; keys missing from it keep their stored value, an empty string removes one. */
  saveConnector(c: Omit<Connector, 'id' | 'secrets'> & { id?: string; secrets?: Record<string, string> }): Promise<ConnectorView>
  deleteConnector(id: string): Promise<void>
  /** Re-reads backends.json and the plugin list. */
  /** Re-reads backends.json; on an error the previous backends stay active and the error is returned. */
  reloadBackends(): Promise<{ backends: BackendSummary[]; error?: string }>
  backendsConfigStatus(): Promise<{ error?: string; example: string }>
  appInfo(): Promise<AppInfo>
  /** Moves a request the project chat answered inline into a new thread. */
  convertToThread(conversationId: string, messageId: string): Promise<void>
  checkForUpdates(): Promise<UpdateCheck>
  backendAuthMethods(backendId: string): Promise<{ id: string; name: string; description?: string }[]>
  /** Runs the backend's sign-in flow (may open a browser). */
  backendLogin(backendId: string, methodId: string): Promise<AccountStatus>
  /** Opens a terminal running the backend's sign-in command (e.g. `qodercli login`). */
  backendTerminalLogin(backendId: string): Promise<void>
  listProjectFiles(projectId: string): Promise<{ name: string; size: number; updatedAt: number }[]>
  /** data is base64. */
  addProjectFiles(projectId: string, files: { name: string; data: string }[]): Promise<void>
  deleteProjectFile(projectId: string, name: string): Promise<void>
  updateProgress(projectId: string, patch: ProgressPatch): Promise<ProgressItem>
  deleteProgress(projectId: string, id: string): Promise<void>
  /** Existing folders a message mentions (a file's own folder for a file path). */
  foldersInText(text: string): Promise<string[]>
  /** Likely project folders (git repositories under the usual places); with `onlyMatching`, only names matching the hint. */
  suggestFolders(hint: string, onlyMatching?: boolean): Promise<FolderCandidate[]>

  updateSettings(patch: Partial<AppSettings>): Promise<void>
  setBackendSetting(backendId: string, key: string, value: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  pickFolder(): Promise<string | null>
  /** Opens the folder holding backends.json in the system file manager. */
  openConfigFolder(): Promise<void>
  /** Saves a conversation as Markdown via a save dialog; false if cancelled. */
  exportConversation(conversationId: string): Promise<boolean>

  platform: string
  windowControl(action: 'minimize' | 'maximize' | 'close'): void
}

/** Glass used to be a theme of its own (always dark); it is now a switch over light or dark. */
export function normalizeTheme<T extends Partial<Pick<AppSettings, 'theme' | 'glass'>>>(s: T): T {
  return s.theme === 'glass' ? { ...s, theme: 'dark', glass: true } : s
}
