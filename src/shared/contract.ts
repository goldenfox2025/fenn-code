/**
 * The backend-neutral "translation contract".
 *
 * Everything outside `src/main/backends/` talks to agents only through the
 * types in this file. No ACP types, vendor names or CLI details may appear
 * here: a backend plugin translates its own protocol into these shapes.
 */

// ---------------------------------------------------------------------------
// What a backend streams back during a turn
// ---------------------------------------------------------------------------

export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed'

export type AgentEvent =
  | { kind: 'message.delta'; text: string }
  | { kind: 'thought.delta'; text: string }
  /** `paths`: the files the call works on (ACP locations and diffs). */
  | { kind: 'tool.start'; toolId: string; title: string; toolKind?: string; status: ToolStatus; input?: string; paths?: string[] }
  | { kind: 'tool.update'; toolId: string; title?: string; status?: ToolStatus; output?: string; toolKind?: string; paths?: string[] }
  | { kind: 'plan'; entries: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  /** The session's other choices changed (e.g. the agent switched its own mode). */
  | { kind: 'options'; options: SessionOption[]; /** The option the user just set by typing its command: their choice now. */ typed?: string }
  /** A status note; a later notice with the same key replaces it (e.g. retry progress). */
  | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string; key?: string }
  /** The slash commands the agent offers now (ACP available_commands_update), without the slash. */
  | { kind: 'commands'; names: string[]; commands?: { name: string; description?: string }[] }
  /** A command the agent runs through the app started or ended (shown as background work). */
  | { kind: 'background'; id: string; command: string; state: 'running' | 'exited'; exitCode?: number | null }
  /** The user made this folder the working folder of a session that had none. */
  | { kind: 'folder'; path: string }
  /** The agent compacted the session's context (ACP compaction_update, completed). */
  | { kind: 'compacted' }
  /** How full the context window is, and what the session has cost so far (cumulative), as the backend reports. */
  | { kind: 'usage'; contextUsed?: number; contextSize?: number; cost?: Cost }

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | 'error'

export interface Cost {
  amount: number
  currency: string
}

/** An account quota snapshot, never a per-message cost or a context window. */
export interface CreditQuota {
  buckets: { name: string; used?: number; total?: number; remaining?: number; unit: string }[]
  at: number
}

/** What an agent CLI's own session log says about a session (read-only). */
export interface SessionContext {
  /** Tokens in the context as of the last model call; unset when the log can't tell. */
  used?: number
  /** The window size, when the log says. */
  size?: number
  model?: string
  /** The latest turn's usage, for agents that report it only in their log (Grok). */
  turn?: TurnUsage & { cost?: Cost }
  /** Tells one logged turn from the next, so an old turn is never counted again. */
  turnKey?: string
}

/** Tokens one turn used, exactly as the backend reported them. Fields it left out stay unset. */
export interface TurnUsage {
  input?: number
  output?: number
  total?: number
  thought?: number
  cachedRead?: number
  cachedWrite?: number
}

export interface TurnResult {
  stopReason: StopReason
  error?: string
  /** Absent when the backend reported no usage for the turn. */
  usage?: TurnUsage
}

// ---------------------------------------------------------------------------
// What a backend may ask of the host
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  requestId: string
  sessionId: string
  title: string
  detail?: string
  options: { id: string; label: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[]
  /**
   * Computer control: the apps asked for, each with a suggested tier. The user
   * can change each tier; the answer is then `allow:` + JSON {key: tier|'none'}.
   */
  apps?: { key: string; name: string; tier: 'view' | 'click' | 'full'; running: boolean }[]
}

/** null means the user dismissed the prompt (treated as cancelled). */
export type PermissionDecision = string | null

// ---------------------------------------------------------------------------
// The backend itself
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  name: string
  description?: string
}

/**
 * A choice a session offers besides the model: how the agent asks before
 * acting ('mode'), how hard it thinks ('thought_level'), or anything else.
 */
export interface SessionOption {
  id: string
  name: string
  category?: 'mode' | 'thought_level' | string
  current?: string
  choices: { value: string; name: string; description?: string }[]
}

export interface SessionInfo {
  sessionId: string
  models?: ModelInfo[]
  currentModelId?: string
  options?: SessionOption[]
  /** The agent took NewSessionOptions.system as its system prompt, so it outlives compaction. */
  systemApplied?: boolean
}

/** Whether the user is signed in to a backend, checked without starting a session. */
export interface AccountStatus {
  signedIn?: boolean
  /** One short line, e.g. the version or account name. */
  detail?: string
  /** False when the backend's program is not installed (not found). */
  installed?: boolean
  /** The installed program's version, when it says. */
  version?: string
}

/** A command a plugin declares (run with the user's environment, proxy settings included). */
export interface CommandSpec {
  command: string
  args?: string[]
}

/** How to bring a backend's program up to date from the app. */
export interface UpgradeSpec {
  /** Installs the latest version, e.g. `npm install -g some-cli@latest`. */
  run: CommandSpec
  /** Prints the latest available version (the first x.y.z in its output is used). */
  latest?: CommandSpec
  /** Runs after `run` succeeds, e.g. a setup step npm may have skipped. */
  after?: CommandSpec & { label: string; labelArgs?: unknown[] }
  /** It installs the one version this Ancora release was made for: offered while missing, never as an update. */
  installOnly?: boolean
}

export type PromptPart =
  | { type: 'text'; text: string }
  /** base64 image data */
  | { type: 'image'; mimeType: string; data: string; name?: string }
  /** a text file the user attached */
  | { type: 'file'; name: string; mimeType: string; text: string; path?: string }

/**
 * Tool servers (MCP, Model Context Protocol) an agent session should use:
 * the app's own tools (an HTTP endpoint) plus any connectors the user added
 * (HTTP or a local command). Backends forward them however their protocol
 * allows; one that cannot use tools simply ignores them.
 */
export type HostToolServer =
  | { name: string; url: string; headers?: Record<string, string> }
  | { name: string; command: string; args?: string[]; env?: Record<string, string> }

export interface NewSessionOptions {
  cwd: string
  /**
   * The user's working folder for this conversation, if it has one. File and
   * terminal access the app provides is rooted here; without it the agent
   * gets no terminal and needs the user's OK for each file.
   */
  folder?: string
  tools?: HostToolServer[]
  /** The app's notes for this conversation, as a system prompt when the agent accepts one (ACP sessionCapabilities.systemPrompt). */
  system?: string
}

export interface AgentBackend {
  /** Launch / connect. Resolves once the backend can create sessions. */
  start(): Promise<void>
  newSession(opts: NewSessionOptions): Promise<SessionInfo>
  /**
   * Reattaches to a session from an earlier run (e.g. after an app restart).
   * Resolves null when the backend cannot resume sessions; the app then starts a
   * new one and replays the transcript as context.
   */
  resumeSession?(opts: NewSessionOptions & { sessionId: string }): Promise<SessionInfo | null>
  /**
   * Frees a session the app no longer needs (if the backend can). `discard`: a background chore's
   * session, also removed from the agent's own history where it can (Codex archives it).
   */
  closeSession?(sessionId: string, opts?: { discard?: boolean }): Promise<void>
  /** Starts the agent before it is needed (and, where its first session is slow to open, opens and discards one). Sends nothing. */
  warm?(cwd: string): Promise<void>
  /** Runs one turn. Events stream through BackendHost.emit until it resolves. */
  prompt(sessionId: string, parts: PromptPart[]): Promise<TurnResult>
  cancel(sessionId: string): Promise<void>
  /** Stops a command the agent started through the app. */
  stopCommand?(sessionId: string, id: string): Promise<boolean>
  setModel?(sessionId: string, modelId: string): Promise<void>
  /** Sets one of the session's options; resolves with the options as they are now. */
  setOption?(sessionId: string, optionId: string, value: string): Promise<SessionOption[] | undefined>
  /** Ways the user can sign in to this backend (e.g. a browser login). Starts the backend if needed. */
  authMethods?(): Promise<AuthMethod[]>
  /** Runs a sign-in flow; may open the user's browser. Resolves when signed in. */
  authenticate?(methodId: string): Promise<void>
  /** Whether the agent accepts images (and so can look at screenshots); undefined until known. */
  acceptsImages?(): boolean | undefined
  /** Stops the agent. `reason` (plain Chinese) becomes the error of any reply still running. */
  dispose(reason?: string): Promise<void>
}

export interface AuthMethod {
  id: string
  name: string
  description?: string
}

/** Services the app provides to every backend. */
export interface BackendHost {
  emit(sessionId: string, event: AgentEvent): void
  requestPermission(req: Omit<PermissionRequest, 'requestId'>): Promise<PermissionDecision>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  /**
   * The backend lost all its live sessions (e.g. the agent process crashed).
   * The app will start new sessions and replay context on the next turn.
   */
  sessionsLost(): void
  /** Values the user entered for this plugin's declared settings. */
  config: Record<string, string>
  /** Directory with files bundled alongside the app (helper scripts, assets). */
  resourcesDir: string
  /** Command that runs a Node.js script without requiring Node to be installed. */
  nodeCommand: { command: string; env: Record<string, string> }
  /** Whether the user may make this folder a conversation's working folder. */
  canWorkIn?(path: string): boolean
}

/** A setting a plugin needs from the user, e.g. an API key. */
export interface PluginSetting {
  key: string
  label: string
  secret?: boolean
  placeholder?: string
  help?: string
}

/** One drop-in file under src/main/backends/plugins/ exports one of these. */
export interface BackendPlugin {
  id: string
  name: string
  description?: string
  settings?: PluginSetting[]
  /** The agent can sign in from the app (ACP authenticate), so settings show a 「登录」 button. */
  signIn?: boolean
  /** A command that signs in from a terminal (e.g. `qodercli login`); settings show a 「登录」 button that opens it. */
  login?: { command: string; args?: string[] } | ((config: Record<string, string>) => { command: string; args?: string[] })
  /**
   * What the plugin was built from. When a reload produces a plugin with the
   * same id and signature, the running instance is kept instead of restarted.
   */
  signature?: string
  /** Only for automated tests: left out of the app unless the demo agent is switched on. */
  testOnly?: boolean
  optionPolicy?: import('./sessionOptions').SessionOptionPolicy
  /** Checks local program availability without starting an agent or a sign-in command. */
  isInstalled?(config: Record<string, string>): boolean
  /** Checks the sign-in state without starting a session (e.g. by running a status command). */
  account?(config: Record<string, string>): Promise<AccountStatus>
  /** Read-only account Credits lookup; it must not send an agent prompt. */
  credits?(config: Record<string, string>): Promise<CreditQuota | undefined>
  /** How to upgrade the backend's program; settings show 「升级」 only when this is set. */
  upgrade?: UpgradeSpec
  /** Read-only: how full a session's context is, from the agent CLI's own session log. */
  sessionContext?(sessionId: string): Promise<SessionContext | undefined>
  create(host: BackendHost): AgentBackend
}

// ---------------------------------------------------------------------------
// What the app layer sees from the backend manager
// ---------------------------------------------------------------------------

export interface BackendSummary {
  id: string
  name: string
  installed?: boolean
  optionPolicy?: import('./sessionOptions').SessionOptionPolicy
  description?: string
  settings: PluginSetting[]
  /** Which settings currently have a value (values themselves never leave main). */
  configured: Record<string, boolean>
  signIn?: boolean
  /** Signs in by running a command in a terminal window. */
  terminalLogin?: boolean
  /** Can report whether the user is signed in (see BackendPlugin.account). */
  account?: boolean
  credits?: boolean
  /** Can be upgraded from the app (see BackendPlugin.upgrade). */
  upgrade?: boolean
  /** Offered only to install (see UpgradeSpec.installOnly). */
  upgradeInstallOnly?: boolean
  /** The commands installing or upgrading runs, one per line, as shown before asking. */
  upgradeCommands?: string[]
  /** A follow-up step after the commands, described in words. */
  upgradeNote?: string
  /** Accepts images (needed for computer control); undefined until the backend has started. */
  images?: boolean
}

export type HostEvent =
  | { type: 'agent'; backendId: string; sessionId: string; event: AgentEvent }
  | { type: 'permission'; backendId: string; request: PermissionRequest }
  | { type: 'backend-log'; backendId: string; level: string; message: string }
  | { type: 'permission-dropped'; backendId: string; requestId: string }
