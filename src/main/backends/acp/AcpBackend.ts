/**
 * Generic ACP (Agent Client Protocol) adapter.
 *
 * Translates between any ACP agent spoken over stdio and the app's
 * backend-neutral contract. This is the only module allowed to import
 * `@agentclientprotocol/sdk`.
 */
import { tap } from './debugLog'
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { basename, join } from 'node:path'
import { Workspaces, outputDecoder, stopAgentProcess } from '../workspace'
import { t, tk } from '../../../shared/i18n'
import { classifyError } from '../../../shared/errors'
import { trustsAgent, visibleSessionOptions } from '../../../shared/sessionOptions'
import { resolveModelAliases, resolveOptionAliases } from '../../../shared/aliases'
import { findOnPath } from '../install'

/** How long to wait before retrying a turn that failed because the sign-in was being renewed. */
const REFRESH_RETRY_MS = 3000
import * as acp from '@agentclientprotocol/sdk'
import type {
  TurnUsage,
  AgentBackend,
  AgentEvent,
  AuthMethod,
  BackendHost,
  ModelInfo,
  NewSessionOptions,
  PromptPart,
  SessionInfo,
  SessionOption,
  ToolStatus,
  TurnResult
} from '../../../shared/contract'

export interface AcpLaunchSpec {
  command: string
  args: string[]
  /** Extra environment for the agent process, evaluated against the plugin's settings. */
  env?: Record<string, string | undefined>
  cwd?: string
}

/** Per-agent quirks a plugin can declare without touching the generic adapter. */
export interface AcpQuirks {
  /** Hide the provider's non-actionable "none" reasoning choice. */
  hideNoneReasoning?: boolean
  /** Translate a vendor extension notification (`_vendor/...`) into a contract event. */
  translateExt?(method: string, params: Record<string, unknown>): { sessionId: string; events: AgentEvent[] } | null
  /** Shown when the agent says authentication is required. */
  authHint?: string
  /** Shown when the agent's program can't be found (instead of a bare ENOENT). */
  missingHint?: string
  /**
   * The agent's reported input already counts cache reads (OpenAI-style: Codex,
   * Grok). Anthropic-style input (Claude Code) does not.
   */
  inputIncludesCache?: boolean
  /**
   * The `session/new` `_meta` field that appends to the agent's system prompt, for
   * agents that take one there instead of ACP sessionCapabilities.systemPrompt (Grok: `rules`).
   * A dotted path (Antigravity: `antigravity.systemPrompt.append`) is nested, and used only
   * when the agent advertises the same path in its capabilities' `_meta`.
   */
  systemPromptMeta?: string
  /**
   * A note on the session's working folder, added to the system prompt above. Antigravity takes session/new
   * cwd as a root but tells its model another folder (its skills folder) is the working directory.
   */
  workingFolderNote?(cwd: string): string
  /**
   * A sign-in the agent needs again in each new process, and can do without the user (an API key
   * in settings, or a stored token it refreshes). Tried once when a session says it needs sign-in.
   */
  autoAuth?(config: Record<string, string>): string | undefined
  /**
   * A choice the agent offers only as a / command (Grok's `/always-approve on|off`), shown as a
   * session option like any other. Picking a value sends its command as a quiet prompt.
   */
  commandOption?: CommandOption
  /**
   * The `_meta` field on session updates and prompt results that holds how many tokens the
   * context holds now (Grok: `totalTokens`, the figure its own /session-info shows).
   */
  contextTokensMeta?: string
  /**
   * The agent's first session in a process is slow to open and later ones are quick (Codex loads its
   * config, plugins and MCP servers once): warming up opens and discards one.
   */
  warmSession?: boolean
  /** / commands that do nothing over ACP, sent as another command that answers (Grok: /context → /session-info). */
  commandAliases?: Record<string, string>
  /** Told once the agent's process has answered `initialize` (e.g. to look up the processes it started). */
  started?(proc: ChildProcess): void
  /**
   * Sees when each session opens (session/new, load or resume) and when the
   * app closes it (Antigravity: ends the helper program a session started and the server keeps).
   */
  /** See AgentBackend.openSessionLimit. */
  openSessionLimit?: number
  sessionTracker?: {
    begin(sessionId?: string): (sessionId: string) => void
    closed(sessionId: string, proc: ChildProcess | undefined): void
    exited(): void
  }
  /**
   * The launch passes the model for new chats (host.defaultModel) and a session opens on it, while
   * switching later is slow (Antigravity restarts its harness): a changed choice restarts the idle process.
   */
  modelAtStart?: boolean
  /** Each session/new takes seconds even in a running process (Antigravity creates its conversation): see AgentBackend.wantsSpare. */
  spareSession?: boolean
  /**
   * Brings back a session hidden from the agent's own app (Codex: `codex unarchive`), which the agent
   * can't resume while hidden. Set for plugins with an appListing; there, session/delete only hides (archives).
   */
  unhide?(sessionId: string): Promise<void>
  /** Stops the agent's process its own way (Antigravity: so it can clean up after itself); resolves once it is done. */
  stop?(proc: ChildProcess): Promise<void>
}

export interface CommandOption {
  id: string
  name: string
  category: 'mode'
  /** The value a new session starts with. */
  initial: string
  choices: { value: string; name: string; command: string }[]
}

interface ModelSelector {
  configId?: string
  models: ModelInfo[]
  current?: string
}

/**
 * Runs a request from the agent; a refusal reaches it in the error message ("the user did not allow…"),
 * where the SDK would otherwise send a bare "Internal error" and tuck the reason away in its data.
 */
async function said<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof acp.RequestError) throw err
    throw new acp.RequestError(-32603, errorText(err))
  }
}

const OPTION_LABEL: Record<string, string> = {
  allow_always: tk('总是允许'),
  allow_once: tk('允许'),
  reject_once: tk('不允许'),
  reject_always: tk('总是拒绝')
}

/**
 * The card's buttons in the app's own words, by kind: an agent's labels are in its language ("Allow Always").
 * Codex offers a second allow_always that lasts the session (allow_session); no two buttons read the same.
 */
export function optionLabels(options: { optionId: string; name: string; kind: string }[]): { id: string; label: string; kind: acp.PermissionOptionKind }[] {
  const out: { id: string; label: string; kind: acp.PermissionOptionKind }[] = []
  let always = false
  for (const o of options) {
    const session = o.kind === 'allow_always' && (/session/i.test(o.optionId) || (always && !/always/i.test(o.optionId)))
    if (o.kind === 'allow_always' && !session) always = true
    const label = session ? t('本次会话内允许') : OPTION_LABEL[o.kind] ? t(OPTION_LABEL[o.kind]) : o.name
    if (out.some((x) => x.label === label)) continue
    out.push({ id: o.optionId, label, kind: o.kind as acp.PermissionOptionKind })
  }
  return out
}

/** A card's heading by the call's kind, where the agent titles it in English ("Run command"); its own title goes in the details. */
const KIND_HEADING: Record<string, string> = {
  execute: tk('运行命令'),
  edit: tk('修改文件'),
  delete: tk('删除文件'),
  move: tk('移动文件'),
  read: tk('读取文件'),
  fetch: tk('访问网络'),
  other: tk('使用工具')
}

/** The heading and details of a permission card for this call. */
export function permissionText(call: { title?: string | null; kind?: string | null; rawInput?: unknown }): { title: string; detail?: string } {
  const own = call.title?.trim()
  const input = stringify(call.rawInput)
  const heading = KIND_HEADING[call.kind ?? 'other'] ?? KIND_HEADING.other
  if (own && /\p{Script=Han}/u.test(own)) return { title: own, detail: input }
  if (!own) return { title: t(heading), detail: input }
  return { title: t(heading), detail: input ? `${own}\n${input}` : own }
}

/**
 * The tool a call runs, as `mcp__server__tool` where the agent says which MCP server it is (its metadata
 * first, then its title), so the app's own tools are matched however each agent names them:
 * Qoder `_meta.qoder.toolName` or "X (fenn MCP Server)", Claude `_meta.claudeCode.mcpServer.name`,
 * Codex `rawInput {server, tool}` (its permission request has no title; the earlier call does), Grok `rawInput.tool_name`.
 */
export function toolNameOf(call: { title?: string | null; rawInput?: unknown; _meta?: unknown }): string | undefined {
  const meta = (call._meta ?? {}) as { qoder?: { toolName?: unknown }; claudeCode?: { mcpServer?: { name?: unknown } } }
  const raw = (call.rawInput ?? {}) as { server?: unknown; tool?: unknown; tool_name?: unknown }
  const title = call.title?.trim()
  if (typeof meta.qoder?.toolName === 'string') return meta.qoder.toolName
  const server = meta.claudeCode?.mcpServer?.name
  if (typeof server === 'string' && title) return `mcp__${server}__${title.replace(/^mcp__.+?__/, '')}`
  if (typeof raw.server === 'string' && typeof raw.tool === 'string') return `mcp__${raw.server}__${raw.tool}`
  if (typeof raw.tool_name === 'string') return raw.tool_name
  const named = title && /^([A-Za-z0-9_]+) \(([A-Za-z0-9_-]+)(?: MCP Server)?\)$/.exec(title)
  if (named) return `mcp__${named[2]}__${named[1]}`
  return title || undefined
}

const TOOL_STATUS: Record<string, ToolStatus> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'completed',
  failed: 'failed'
}

export class AcpBackend implements AgentBackend {
  private proc?: ChildProcess
  private conn?: acp.ClientSideConnection
  private starting?: Promise<void>
  private modelSelectors = new Map<string, ModelSelector>()
  /** Compactions already shown as a step. */
  private compactions = new Set<string>()
  /** Recent tool calls by id: a permission request may name only the id (Codex). */
  private calls = new Map<string, { title?: string | null; kind?: string | null; rawInput?: unknown; _meta?: unknown }>()
  /** Each session's non-model choices; `legacy` marks ACP session modes (set with session/set_mode). */
  private sessionOptions = new Map<string, (SessionOption & { legacy?: boolean; command?: boolean })[]>()
  /** Each model's context window, where the agent lists it (`_meta.totalContextTokens`). */
  private modelWindows = new Map<string, number>()
  /** The context figure last passed on per session, so only a change is sent. */
  private contextTokens = new Map<string, number>()
  /** Sessions whose updates are not shown: a command sent for a session option is running. */
  private quiet = new Set<string>()
  /** Why the agent process last exited, for readable errors. */
  private exitReason?: string
  /** Why the app stopped a process on purpose, shown instead of its raw exit signal. */
  private stopReasons = new WeakMap<object, string>()
  private caps?: acp.AgentCapabilities
  private auth: AuthMethod[] = []
  /** Sessions being loaded: history the agent replays must not reach the app. */
  private replaying = new Set<string>()
  /** Sessions the app has open in this process (not the ones warming up or listing models discards). */
  private open = new Set<string>()
  /** Files and commands the agent reaches through the app, kept to each session's working folder. */
  private workspaces: Workspaces

  private missing(command: string): string {
    const how = this.quirks.missingHint
      ? t(this.quirks.missingHint)
      : t('请先安装它，并确认它在 PATH 里；装好后到 设置 → Agent 后端 点「重新加载」。')
    return t('找不到 {0} 的程序「{1}」。', this.name, command) + how
  }

  constructor(
    private readonly name: string,
    private readonly resolveSpec: () => AcpLaunchSpec | Promise<AcpLaunchSpec>,
    private readonly host: BackendHost,
    private readonly quirks: AcpQuirks = {}
  ) {
    this.workspaces = new Workspaces({
      ask: async (sessionId, title, detail, adopt) => {
        const d = await this.host.requestPermission({
          sessionId,
          title,
          detail,
          options: [
            { id: 'allow', label: t('允许'), kind: 'allow_once' },
            ...(adopt ? [{ id: 'adopt', label: t('设为工作文件夹：{0}', basename(adopt) || adopt), kind: 'allow_always' as const }] : []),
            { id: 'reject', label: t('拒绝'), kind: 'reject_once' }
          ]
        })
        return d === 'allow' || d === 'adopt' ? d : 'reject'
      },
      trusted: (sessionId) => trustsAgent(this.sessionOptions.get(sessionId)),
      canWorkIn: (path) => !!this.host.canWorkIn?.(path),
      adopted: (sessionId, folder) => this.host.emit(sessionId, { kind: 'folder', path: folder }),
      onTerminal: (sessionId, e) => this.host.emit(sessionId, { kind: 'background', ...e })
    })
  }

  start(): Promise<void> {
    this.starting ??= this.launch().catch((err) => {
      this.starting = undefined
      throw err
    })
    return this.starting
  }

  private async launch(): Promise<void> {
    const spec = await this.resolveSpec()
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const [k, v] of Object.entries(spec.env ?? {})) if (v) env[k] = v

    if (!findOnPath(spec.command, env)) throw new Error(this.missing(spec.command))

    const { command, args, shell } = windowsSafe(spec.command, spec.args)
    const proc = spawn(command, args, {
      cwd: spec.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
      windowsHide: true
    })
    this.proc = proc
    this.exitReason = undefined
    // Each process keeps its own stderr, so an error never repeats an earlier process's output.
    const errTail: string[] = []
    let ready = false
    // A Chinese Windows writes GBK where a program doesn't choose UTF-8.
    const errText = outputDecoder()
    proc.stderr!.on('data', (buf: Buffer) => {
      const chunk = errText.write(buf)
      if (!chunk) return
      errTail.push(chunk)
      if (errTail.length > 40) errTail.shift()
      this.host.log('debug', `[${this.name} stderr] ${chunk.trimEnd()}`)
    })
    const exited = new Promise<never>((_, reject) => {
      proc.once('error', (e: NodeJS.ErrnoException) =>
        reject(
          new Error(
            e.code === 'ENOENT'
              ? this.missing(spec.command)
              : t('无法启动 {0}：{1}', this.name, e.message)
          )
        )
      )
      proc.once('exit', (code, signal) => {
        const wasUs = this.proc !== proc
        this.conn = undefined
        this.warmed = undefined
        this.starting = undefined
        if (!wasUs) this.open.clear()
        this.quirks.sessionTracker?.exited()
        // Through a shell (Windows .cmd), a missing program shows up as an exit, not ENOENT.
        const how = signal ?? `code ${code}`
        const startHow = signal ? t('信号 {0}', signal) : t('代码 {0}', code ?? '?')
        this.exitReason = /is not recognized as an internal or external command|command not found/i.test(errTail.join(''))
          ? this.missing(spec.command)
          : this.stopReasons.get(proc) ??
            // Once running, what it printed (often raw JSON) goes only to the log; at start it says what is missing.
            (ready ? t('{0} 意外退出了，点「重试」继续。', this.name) : t('{0} 启动后立即退出了（{1}）。', this.name, startHow) + tail(errTail, '\n'))
        if (ready && !wasUs && !this.stopReasons.has(proc)) this.host.log('warn', `${this.name} exited (${how})${tail(errTail)}`)
        reject(new Error(this.exitReason))
        // Sessions lived in that process; tell the app so it can start over cleanly.
        if (!wasUs) this.host.sessionsLost()
      })
    })
    exited.catch(() => {})

    // Both directions pass through the opt-in debug log (a no-op while it is off).
    const toAgent = tap(this.name, 'out')
    toAgent.readable.pipeTo(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>).catch(() => {})
    const raw = acp.ndJsonStream(
      toAgent.writable,
      (Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>).pipeThrough(tap(this.name, 'in'))
    )
    const stream = { writable: raw.writable, readable: raw.readable.pipeThrough(dropStrayResponses()) }
    this.conn = new acp.ClientSideConnection(() => this.clientHandler(), stream)

    const init = await Promise.race([
      this.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        // compaction: the agent says when it compacted, so the app can hand its notes over again.
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, session: { compaction: {} } } as acp.ClientCapabilities,
        clientInfo: { name: 'fenn', version: '0.1.0' }
      }).catch(async (err) => {
        // stdout closing beats the exit event; wait a moment so the exit reason (with stderr) is what shows.
        await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))])
        throw err
      }),
      exited
    ])
    ready = true
    this.caps = init.agentCapabilities ?? undefined
    this.auth = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description ?? undefined }))
    this.host.log('info', `${this.name} initialized (protocol v${init.protocolVersion})`)
    this.quirks.started?.(proc)
  }

  private clientHandler(): acp.Client {
    return {
      sessionUpdate: async ({ sessionId, update, _meta }) => {
        // Even a replayed or quiet update says how full the context is now.
        this.metaContext(sessionId, _meta)
        // Session metadata is not replayed reply text; late title updates also
        // remain relevant while a quiet slash command is running.
        if (update.sessionUpdate === 'session_info_update') {
          const event = translateUpdate(update)
          if (event) this.host.emit(sessionId, event)
          return
        }
        if (this.replaying.has(sessionId) || this.quiet.has(sessionId)) return
        if (update.sessionUpdate === 'tool_call') {
          this.calls.set(`${sessionId}:${update.toolCallId}`, { title: update.title, kind: update.kind, rawInput: update.rawInput, _meta: update._meta })
          if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value!)
        }
        const ev = translateUpdate(update)
        if (ev) this.host.emit(sessionId, ev)
        if (update.sessionUpdate === 'available_commands_update') {
          const list = (update as { availableCommands?: { name?: string; description?: string }[] }).availableCommands ?? []
          const commands = list
            .map((c) => ({ name: String(c.name ?? '').replace(/^\//, ''), description: typeof c.description === 'string' ? c.description.slice(0, 200) : undefined }))
            .filter((c) => c.name)
          this.host.emit(sessionId, { kind: 'commands', names: commands.map((c) => c.name), commands })
        } else if (update.sessionUpdate === 'compaction_update') {
          // Shown as a step in the reply, as the agent shows it to clients that don't ask for these updates.
          const c = update as { compactionId: string; status?: string }
          const status: ToolStatus = c.status === 'completed' ? 'completed' : c.status === 'in_progress' ? 'running' : 'failed'
          const toolId = `compaction:${c.compactionId}`
          if (!this.compactions.has(toolId)) {
            this.compactions.add(toolId)
            this.host.emit(sessionId, { kind: 'tool.start', toolId, title: t('压缩上下文'), toolKind: 'other', status })
          } else this.host.emit(sessionId, { kind: 'tool.update', toolId, status })
          if (c.status === 'completed') this.host.emit(sessionId, { kind: 'compacted' })
        } else if (update.sessionUpdate === 'config_option_update') {
          const configOptions = (update as { configOptions?: unknown }).configOptions
          this.captureModels(sessionId, configOptions, undefined)
          this.captureOptions(sessionId, configOptions, undefined)
          this.emitOptions(sessionId)
        } else if (update.sessionUpdate === 'current_mode_update') {
          const mode = this.sessionOptions.get(sessionId)?.find((o) => o.legacy || o.category === 'mode')
          if (mode) mode.current = (update as { currentModeId?: string }).currentModeId ?? mode.current
          this.emitOptions(sessionId)
        }
      },
      requestPermission: async ({ sessionId, toolCall, options }) => {
        // What the request leaves out, the call it is for said.
        const earlier = this.calls.get(`${sessionId}:${toolCall.toolCallId}`)
        const call = {
          title: toolCall.title ?? earlier?.title,
          kind: toolCall.kind ?? earlier?.kind,
          rawInput: toolCall.rawInput ?? earlier?.rawInput,
          _meta: toolCall._meta ?? earlier?._meta
        }
        const decision = await this.host.requestPermission({
          sessionId,
          ...permissionText(call),
          options: optionLabels(options),
          toolName: toolNameOf(call),
          toolKind: call.kind ?? undefined,
          paths: toolCall.locations?.map((l) => l.path)
        })
        return decision
          ? { outcome: { outcome: 'selected', optionId: decision } }
          : { outcome: { outcome: 'cancelled' } }
      },
      readTextFile: ({ sessionId, path, line, limit }) => said(async () => ({
        content: await this.workspaces.readTextFile(sessionId, path, line, limit)
      })),
      writeTextFile: ({ sessionId, path, content }) => said(async () => {
        await this.workspaces.writeTextFile(sessionId, path, content)
        return {}
      }),
      createTerminal: (req) => said(async () => ({ terminalId: await this.workspaces.createTerminal(req.sessionId, req) })),
      terminalOutput: async ({ terminalId }) => this.workspaces.output(terminalId),
      waitForTerminalExit: async ({ terminalId }) => this.workspaces.waitForExit(terminalId),
      killTerminal: async ({ terminalId }) => {
        this.workspaces.kill(terminalId)
        return {}
      },
      releaseTerminal: async ({ terminalId }) => {
        this.workspaces.release(terminalId)
        return {}
      },
      // Vendor extensions (e.g. `_x.ai/...`) are not part of the contract unless a plugin translates them.
      extNotification: async (method, params) => {
        const t = this.quirks.translateExt?.(method, params)
        if (t) for (const e of t.events) this.host.emit(t.sessionId, e)
      },
      extMethod: async () => ({})
    }
  }

  /**
   * The app's tools are an HTTP MCP server. Agents that only take stdio MCP
   * servers (stdio is the one every ACP agent must support) get a tiny bridge
   * process that relays to it.
   */
  async authMethods(): Promise<AuthMethod[]> {
    await this.start()
    return this.auth
  }

  async authenticate(methodId: string): Promise<void> {
    await this.start()
    await this.conn!.authenticate({ methodId })
  }

  private mcpServers(tools: NewSessionOptions['tools']): acp.McpServer[] {
    const http = !!this.caps?.mcpCapabilities?.http
    const env = (e?: Record<string, string>) => Object.entries(e ?? {}).map(([name, value]) => ({ name, value }))
    return (tools ?? []).flatMap((t): acp.McpServer[] => {
      if ('command' in t) return [{ name: t.name, command: t.command, args: t.args ?? [], env: env(t.env) }]
      if (http) return [{ type: 'http' as const, name: t.name, url: t.url, headers: env(t.headers) }]
      // Relay through a local bridge process; headers (which may hold tokens) go in its environment.
      return [
        {
          name: t.name,
          command: this.host.nodeCommand.command,
          args: [join(this.host.resourcesDir, 'mcp-bridge.mjs'), t.url],
          env: env({ ...this.host.nodeCommand.env, FENN_BRIDGE_HEADERS: JSON.stringify(t.headers ?? {}) })
        }
      ]
    })
  }

  private warmed?: Promise<void>

  warm(cwd: string): Promise<void> {
    this.warmed ??= (async () => {
      await this.start()
      // An agent given a spare session (see wantsSpare) warms up by opening that one: no extra session to throw away.
      if (!this.quirks.warmSession || this.quirks.spareSession) return
      const res = await this.conn!.newSession({ cwd, mcpServers: [] })
      void this.closeSession(res.sessionId, { discard: true })
    })().catch(() => {
      this.warmed = undefined
    })
    return this.warmed
  }

  openSessionLimit(): number | undefined {
    return this.quirks.openSessionLimit
  }

  wantsSpare(): boolean {
    return !!this.quirks.spareSession
  }

  async defaultModelChanged(): Promise<boolean> {
    if (!this.quirks.modelAtStart || !this.proc || this.open.size) return false
    await this.dispose()
    return true
  }

  async closeSession(sessionId: string, opts: { discard?: boolean; hide?: boolean } = {}): Promise<void> {
    this.open.delete(sessionId)
    this.workspaces.close(sessionId)
    this.modelSelectors.delete(sessionId)
    this.sessionOptions.delete(sessionId)
    this.contextTokens.delete(sessionId)
    const caps = this.caps?.sessionCapabilities as { close?: unknown; delete?: unknown } | null | undefined
    if (caps?.close) await this.conn?.closeSession({ sessionId }).catch(() => {})
    // Otherwise it would sit in the agent's own session list (the Codex app shows every one).
    // `hide` only where delete is known to archive (see unhide), never a real delete.
    if ((opts.discard || (opts.hide && this.quirks.unhide)) && caps?.delete) await this.conn?.deleteSession({ sessionId }).catch(() => {})
    this.quirks.sessionTracker?.closed(sessionId, this.proc)
  }

  async resumeSession({ cwd, folder, tools, sessionId, system }: NewSessionOptions & { sessionId: string }): Promise<SessionInfo | null> {
    await this.start()
    this.workspaces.setRoot(sessionId, folder, cwd)
    const mcpServers = this.mcpServers(tools)
    let res: { configOptions?: unknown; models?: unknown; _meta?: Record<string, unknown> | null } | undefined
    // Shown again while it is open (an archived Codex thread can't be resumed); hidden again once released.
    await this.quirks.unhide?.(sessionId).catch((err) => this.host.log('warn', `${this.name} could not unarchive ${sessionId}: ${errorText(err)}`))
    const opened = this.quirks.sessionTracker?.begin(sessionId)
    try {
      if (this.caps?.sessionCapabilities?.resume) {
        res = await this.conn!.resumeSession({ sessionId, cwd, mcpServers, ...this.systemPrompt(system, cwd) } as acp.ResumeSessionRequest)
      } else if (this.caps?.loadSession) {
        this.replaying.add(sessionId)
        try {
          res = await this.conn!.loadSession({ sessionId, cwd, mcpServers, ...this.systemPrompt(system, cwd) } as acp.LoadSessionRequest)
        } finally {
          this.replaying.delete(sessionId)
        }
      } else {
        opened?.('')
        return null
      }
    } catch (err) {
      // A failed resume may still have started the agent's helper for it (Antigravity): let that go too.
      opened?.(sessionId)
      this.quirks.sessionTracker?.closed(sessionId, this.proc)
      this.host.log('warn', `${this.name} could not resume ${sessionId}: ${errorText(err)}`)
      return null
    }
    opened?.(sessionId)
    this.captureModels(sessionId, res?.configOptions, res?._meta?.modelState ?? res?.models)
    this.captureOptions(sessionId, res?.configOptions, (res as { modes?: unknown } | undefined)?.modes)
    this.open.add(sessionId)
    const sel = this.modelSelectors.get(sessionId)
    return { sessionId, models: sel?.models, currentModelId: sel?.current, options: this.optionsOf(sessionId), systemApplied: this.takesSystemPrompt(system) }
  }

  /** The agent accepts a client system prompt (ACP sessionCapabilities.systemPrompt), which survives its compaction. */
  private takesSystemPrompt(system?: string): boolean {
    return !!system && (this.metaPromptPath().length > 0 || !!(this.caps?.sessionCapabilities as { systemPrompt?: unknown } | undefined)?.systemPrompt)
  }

  /** Where in session/new `_meta` the system prompt goes, or [] when it can't go there. */
  private metaPromptPath(): string[] {
    const path = this.quirks.systemPromptMeta?.split('.') ?? []
    if (path.length < 2) return path
    const advertised = path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], (this.caps as { _meta?: unknown } | undefined)?._meta)
    return advertised ? path : []
  }

  private systemPrompt(system: string | undefined, cwd: string): Record<string, unknown> {
    const note = this.quirks.workingFolderNote?.(cwd)
    if (note) system = system ? `${system}\n\n${note}` : note
    if (!this.takesSystemPrompt(system)) return {}
    const path = this.metaPromptPath()
    if (path.length) return { _meta: path.reduceRight<unknown>((inner, k) => ({ [k]: inner }), system) as Record<string, unknown> }
    return { systemPrompt: { mode: 'append', content: [{ type: 'text', text: system! }] } }
  }

  async newSession({ cwd, folder, tools, system }: NewSessionOptions): Promise<SessionInfo> {
    await this.start()
    const mcpServers = this.mcpServers(tools)
    let res: acp.NewSessionResponse
    const open = () => this.conn!.newSession({ cwd, mcpServers, ...this.systemPrompt(system, cwd) } as acp.NewSessionRequest)
    const opened = this.quirks.sessionTracker?.begin()
    try {
      res = await open().catch(async (err) => {
        // Signed in before, in another process: sign in again quietly and try once more.
        const method = classifyError(errorText(err)) === 'auth' ? this.quirks.autoAuth?.(this.host.config) : undefined
        if (!method || !this.auth.some((m) => m.id === method)) throw err
        await this.conn!.authenticate({ methodId: method })
        return open()
      })
    } catch (err) {
      if (opened) {
        const failed = `failed:${Date.now()}:${Math.random()}`
        opened(failed)
        this.quirks.sessionTracker?.closed(failed, this.proc)
      }
      const msg = errorText(err)
      if (classifyError(msg) === 'auth' || classifyError(msg) === 'refresh') {
        const login = this.auth.length ? t('可以在 设置 → Agent 后端 里点「登录」。') : ''
        throw new Error(`${t('{0} 需要登录。', this.name)}${this.quirks.authHint ? t(this.quirks.authHint) : login}`.trim())
      }
      throw new Error(msg)
    }
    opened?.(res.sessionId)
    this.workspaces.setRoot(res.sessionId, folder, cwd)
    this.open.add(res.sessionId)
    const meta = (res as { _meta?: Record<string, unknown> })._meta
    this.captureModels(res.sessionId, res.configOptions, meta?.modelState ?? (res as { models?: unknown }).models)
    this.captureOptions(res.sessionId, res.configOptions, (res as { modes?: unknown }).modes)
    const sel = this.modelSelectors.get(res.sessionId)
    return { sessionId: res.sessionId, models: sel?.models, currentModelId: sel?.current, options: this.optionsOf(res.sessionId), systemApplied: this.takesSystemPrompt(system) }
  }

  async prompt(sessionId: string, parts: PromptPart[]): Promise<TurnResult> {
    await this.start()
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.conn!.prompt({ sessionId, prompt: this.toContent(sessionId, parts) })
        this.typedCommand(sessionId, parts)
        this.metaContext(sessionId, res._meta)
        const usage = turnUsage(res, this.quirks.inputIncludesCache)
        return usage ? { stopReason: normalizeStop(res.stopReason), usage } : { stopReason: normalizeStop(res.stopReason) }
      } catch (err) {
        // If the process died mid-turn, its exit reason says more than "connection closed".
        await new Promise((r) => setTimeout(r, 50))
        const error = this.exitReason ?? errorText(err)
        // Another process was renewing the sign-in; that clears up in a moment, so try once more.
        if (attempt === 0 && !this.exitReason && classifyError(error) === 'refresh') {
          this.host.emit(sessionId, { kind: 'notice', level: 'info', key: 'auth-refresh', text: t('{0} 正在刷新登录状态，稍后自动重试…', this.name) })
          await new Promise((r) => setTimeout(r, REFRESH_RETRY_MS))
          continue
        }
        return { stopReason: 'error', error }
      }
    }
  }

  /** The context figure an agent puts in `_meta` (see AcpQuirks.contextTokensMeta), as a usage event when it changed. */
  private metaContext(sessionId: string, meta: unknown): void {
    const key = this.quirks.contextTokensMeta
    const used = key ? num((meta as Record<string, unknown> | null | undefined)?.[key]) : undefined
    // 0 is a / command the agent answered itself, not an empty context.
    if (!used || this.contextTokens.get(sessionId) === used) return
    this.contextTokens.set(sessionId, used)
    const model = this.modelSelectors.get(sessionId)?.current
    this.host.emit(sessionId, { kind: 'usage', contextUsed: used, contextSize: model ? this.modelWindows.get(model) : undefined })
  }

  /** The user typed the command behind a session option (`/always-approve on`): the option shows it. */
  private typedCommand(sessionId: string, parts: PromptPart[]): void {
    const c = this.quirks.commandOption
    const opt = this.sessionOptions.get(sessionId)?.find((o) => o.command)
    const text = parts.length === 1 && parts[0].type === 'text' ? parts[0].text.trim().replace(/\s+/g, ' ') : ''
    if (!c || !opt || !text.startsWith('/')) return
    const exact = c.choices.find((x) => x.command === text)
    // The bare command toggles between the two choices.
    const toggled = c.choices.length === 2 && c.choices.every((x) => x.command.split(' ')[0] === text) ? c.choices.find((x) => x.value !== opt.current) : undefined
    const next = exact ?? toggled
    if (!next || next.value === opt.current) return
    opt.current = next.value
    this.host.emit(sessionId, { kind: 'options', options: this.optionsOf(sessionId) ?? [], typed: opt.id })
  }

  /** A / command the agent answers only in its own terminal, swapped for one it answers over ACP. */
  private aliased(text: string): string {
    const m = /^\/([\w-]+)(\s.*)?$/s.exec(text.trim())
    const to = m && this.quirks.commandAliases?.[m[1]]
    return to ? `/${to}${m[2] ?? ''}` : text
  }

  /** Maps prompt parts to ACP content, degrading gracefully to what the agent accepts. */
  private toContent(sessionId: string, parts: PromptPart[]): acp.ContentBlock[] {
    const caps = this.caps?.promptCapabilities
    const out: acp.ContentBlock[] = []
    for (const p of parts) {
      if (p.type === 'text') out.push({ type: 'text', text: parts.length === 1 ? this.aliased(p.text) : p.text })
      else if (p.type === 'image') {
        if (caps?.image) out.push({ type: 'image', mimeType: p.mimeType, data: p.data })
        else
          this.host.emit(sessionId, {
            kind: 'notice',
            level: 'warning',
            text: t('{0} 不支持图片输入，已跳过 {1}', this.name, p.name ?? t('图片'))
          })
      } else if (p.type === 'file') {
        const uri = p.path ? pathToFileURL(p.path).href : `file:///attachments/${encodeURIComponent(p.name)}`
        if (caps?.embeddedContext) out.push({ type: 'resource', resource: { uri, mimeType: p.mimeType, text: p.text } })
        else out.push({ type: 'text', text: `<file name="${p.name}">\n${p.text}\n</file>` })
      }
    }
    return out
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn?.cancel({ sessionId })
  }

  async stopCommand(sessionId: string, id: string): Promise<boolean> {
    return this.workspaces.stop(sessionId, id)
  }

  async commandOutput(sessionId: string, id: string): Promise<string | undefined> {
    return this.workspaces.outputOf(sessionId, id)
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const sel = this.modelSelectors.get(sessionId)
    if (sel?.configId) {
      const res = await this.conn!.setSessionConfigOption({ sessionId, configId: sel.configId, value: modelId })
      if (res?.configOptions) {
        this.captureModels(sessionId, res.configOptions, undefined)
        this.captureOptions(sessionId, res.configOptions, undefined)
        this.emitOptions(sessionId)
      }
    } else {
      // Older/unstable ACP agents expose a dedicated method instead of a config option.
      await (this.conn as unknown as { connection: { sendRequest(m: string, p: unknown): Promise<unknown> } })
        .connection.sendRequest('session/set_model', { sessionId, modelId })
    }
    const current = this.modelSelectors.get(sessionId)
    if (current) current.current = modelId
  }

  async setOption(sessionId: string, optionId: string, value: string): Promise<SessionOption[] | undefined> {
    await this.start()
    const opt = this.sessionOptions.get(sessionId)?.find((o) => o.id === optionId)
    if (!opt) throw new Error(t('没有这个选项：{0}', optionId))
    if (opt.command) {
      const command = this.quirks.commandOption?.choices.find((c) => c.value === value)?.command
      if (!command) throw new Error(t('没有这个选项：{0}', `${optionId}=${value}`))
      // The agent handles its own / commands without the model; what it says back isn't part of the chat.
      this.quiet.add(sessionId)
      try {
        const res = await this.conn!.prompt({ sessionId, prompt: [{ type: 'text', text: command }] })
        if (res.stopReason !== 'end_turn') throw new Error(t('{0} 没有执行 {1}', this.name, command))
      } finally {
        this.quiet.delete(sessionId)
      }
      opt.current = value
    } else if (opt.legacy) {
      await this.conn!.setSessionMode({ sessionId, modeId: value })
      opt.current = value
    } else {
      const res = await this.conn!.setSessionConfigOption({ sessionId, configId: optionId, value })
      opt.current = value
      if (res?.configOptions) {
        this.captureModels(sessionId, res.configOptions, undefined)
        this.captureOptions(sessionId, res.configOptions, undefined)
      }
    }
    return this.optionsOf(sessionId)
  }

  private optionsOf(sessionId: string): SessionOption[] | undefined {
    const list = this.sessionOptions.get(sessionId)
    return list?.length ? list.map(({ legacy: _legacy, command: _command, ...o }) => ({ ...o, choices: o.choices.map((c) => ({ ...c })) })) : undefined
  }

  private emitOptions(sessionId: string): void {
    this.host.emit(sessionId, { kind: 'options', options: this.optionsOf(sessionId) ?? [] })
  }

  /**
   * Every select the agent offers besides the model (config options), or its
   * session modes when it has no config options. Unknown shapes are skipped.
   */
  private captureOptions(sessionId: string, configOptions: unknown, modes: unknown): void {
    const before = this.sessionOptions.get(sessionId)?.find((o) => o.command)?.current
    this.captureAgentOptions(sessionId, configOptions, modes)
    // A choice the agent takes only as a command, unless it now offers a mode of its own.
    const c = this.quirks.commandOption
    const list = this.sessionOptions.get(sessionId) ?? []
    if (!c || list.some((o) => o.category === 'mode')) return
    const choices = c.choices.map(({ value, name }) => ({ value, name }))
    this.sessionOptions.set(sessionId, [...list, { id: c.id, name: c.name, category: c.category, command: true, current: before ?? c.initial, choices }])
  }

  private captureAgentOptions(sessionId: string, configOptions: unknown, modes: unknown): void {
    this.sessionOptions.delete(sessionId)
    if (Array.isArray(configOptions)) {
      const list = visibleSessionOptions((configOptions as { id: string; name?: string; category?: string; type: string; currentValue?: unknown; options?: unknown[] }[])
        .filter((o) => o && o.type === 'select' && o.category !== 'model' && typeof o.id === 'string')
        .map((o) => ({
          id: o.id,
          name: o.name ?? o.id,
          category: o.category ?? undefined,
          current: typeof o.currentValue === 'string' ? o.currentValue : undefined,
          choices: (o.options ?? [])
            .flatMap((c: any) => (Array.isArray(c?.options) ? c.options : [c]))
            .filter((c: any) => c && typeof c.value === 'string')
            .map((c: any) => ({ value: c.value, name: c.name ?? c.value, description: c.description ?? undefined }))
        })), this.quirks)
      // Agents that list only the model here may still offer session modes below.
      if (list.length) {
        const { options, fixes } = resolveOptionAliases(list)
        this.sessionOptions.set(sessionId, options)
        // A level the menu can't name ("Default") is set to the one it shows.
        for (const f of fixes)
          void this.conn?.setSessionConfigOption({ sessionId, configId: f.id, value: f.value })
            .catch((err) => this.host.log('warn', `${this.name} could not set ${f.id}: ${errorText(err)}`))
        return
      }
    }
    const m = modes as { currentModeId?: string; availableModes?: { id: string; name: string; description?: string | null }[] } | undefined
    if (m?.availableModes?.length && m.availableModes.length > 1) {
      this.sessionOptions.set(sessionId, [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          legacy: true,
          current: m.currentModeId,
          choices: m.availableModes.map((x) => ({ value: x.id, name: x.name, description: x.description ?? undefined }))
        }
      ])
    }
  }

  acceptsImages(): boolean | undefined {
    return this.caps ? !!this.caps.promptCapabilities?.image : undefined
  }

  async dispose(reason?: string): Promise<void> {
    const p = this.proc
    if (p && reason) this.stopReasons.set(p, reason)
    this.proc = undefined
    this.workspaces.closeAll()
    this.open.clear()
    this.conn = undefined
    this.warmed = undefined
    this.starting = undefined
    if (p) await (this.quirks.stop ? this.quirks.stop(p) : stopAgentProcess(p))
  }

  private captureModels(sessionId: string, configOptions: unknown, legacy: unknown): void {
    // Grok lists each model's window only in its legacy model list.
    for (const m of (legacy as { availableModels?: { modelId: string; _meta?: { totalContextTokens?: unknown } | null }[] } | undefined)?.availableModels ?? []) {
      const size = num(m._meta?.totalContextTokens)
      if (size) this.modelWindows.set(m.modelId, size)
    }
    const opt = Array.isArray(configOptions)
      ? (configOptions as { id: string; category?: string; type: string; currentValue?: string; options?: unknown[] }[])
          .find((o) => o.category === 'model' && o.type === 'select')
      : undefined
    if (opt) {
      const flat = (opt.options ?? []).flatMap((o: any) => (Array.isArray(o.options) ? o.options : [o]))
      const r = resolveModelAliases(flat.map((o: any) => ({ id: o.value, name: o.name, description: o.description ?? undefined })), opt.currentValue)
      this.modelSelectors.set(sessionId, { configId: opt.id, current: r.current, models: r.models })
      return
    }
    const l = legacy as { currentModelId?: string; availableModels?: { modelId: string; name: string; description?: string }[] }
    if (l?.availableModels?.length) {
      const r = resolveModelAliases(l.availableModels.map((m) => ({ id: m.modelId, name: m.name, description: m.description })), l.currentModelId)
      this.modelSelectors.set(sessionId, { current: r.current, models: r.models })
    }
  }
}

function tail(lines: string[], lead = '：\n'): string {
  const t = lines.join('').trim().split('\n').slice(-6).join('\n').slice(-600)
  return t ? `${lead}${t}` : ''
}

/**
 * On Windows, commands like `npx` are .cmd shims that need a shell, but going
 * through a shell splits unquoted paths with spaces. Use the shell only for
 * bare command names and .cmd/.bat files, and quote arguments when we do.
 */
export function windowsSafe(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { command, args, shell: false }
  const isScript = /\.(cmd|bat)$/i.test(command)
  const isBare = !/[\\/]/.test(command) && !/\.(exe|com)$/i.test(command)
  if (!isScript && !isBare) return { command, args, shell: false }
  return { command: cmdQuote(command), args: args.map(cmdQuote), shell: true }
}

/**
 * One argument for a `cmd.exe /d /s /c "..."` line (what spawn's shell option runs), read back
 * unchanged by the program (the C runtime's rules) and by a .cmd shim passing it on with %*.
 * Inside quotes cmd leaves & | < > ^ ( ) alone, and `""` keeps its quote state while the program
 * reads it as one `"`. cmd expands %VAR% even inside quotes, so each % stands outside them as ^%,
 * which no variable name can follow. A newline cannot be passed through cmd at all.
 */
function cmdQuote(a: string): string {
  if (a && !/[\s"&|<>^()%!,;=]/.test(a)) return a
  const s = a
    // Backslashes are literal except before a quote: double those, then each quote is "".
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/(\\*)%/g, '$1$1"^%"')
    .replace(/(\\+)$/, '$1$1')
  return `"${s}"`
}

/**
 * Answers to requests Fenn Code never sent. Grok, for one, writes the replies to
 * its own internal requests (id "skills-reload") to stdout; the SDK would log
 * each as an error. Fenn Code numbers its requests, so a reply with any other id
 * is not for it. Requests and notifications pass untouched.
 */
export function dropStrayResponses<T>(): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(msg, controller) {
      const m = msg as { id?: unknown; method?: unknown }
      if (m && typeof m === 'object' && 'id' in m && !('method' in m) && typeof m.id !== 'number') return
      controller.enqueue(msg)
    }
  })
}

/** The files a tool call works on: its locations and the files its diffs change. */
function toolPaths(u: { locations?: { path: string }[] | null; content?: acp.ToolCallContent[] | null }): string[] | undefined {
  const paths = new Set<string>()
  for (const l of u.locations ?? []) if (l?.path) paths.add(l.path)
  for (const c of u.content ?? []) if (c.type === 'diff' && c.path) paths.add(c.path)
  return paths.size ? [...paths] : undefined
}

function translateUpdate(u: acp.SessionNotification['update']): AgentEvent | null {
  switch (u.sessionUpdate) {
    case 'session_info_update':
      return typeof u.title === 'string' && u.title.trim() ? { kind: 'session.title', title: u.title.trim() } : null
    case 'agent_message_chunk':
      return u.content.type === 'text' ? { kind: 'message.delta', text: u.content.text } : null
    case 'agent_thought_chunk':
      return u.content.type === 'text' ? { kind: 'thought.delta', text: u.content.text } : null
    case 'tool_call':
      return {
        kind: 'tool.start',
        toolId: u.toolCallId,
        title: u.title,
        toolKind: u.kind ?? undefined,
        status: TOOL_STATUS[u.status ?? 'pending'] ?? 'pending',
        input: stringify(u.rawInput),
        paths: toolPaths(u)
      }
    case 'tool_call_update':
      return {
        kind: 'tool.update',
        toolId: u.toolCallId,
        title: u.title ?? undefined,
        status: u.status ? TOOL_STATUS[u.status] : undefined,
        output: toolOutput(u.content) ?? terminalOutput(u._meta) ?? rawText(u.rawOutput),
        toolKind: u.kind ?? undefined,
        paths: toolPaths(u)
      }
    case 'plan':
      return {
        kind: 'plan',
        entries: u.entries.map((e) => ({ content: e.content, status: e.status }))
      }
    case 'usage_update': {
      const x = u as { used?: unknown; size?: unknown; cost?: { amount?: unknown; currency?: unknown } | null }
      const cost =
        x.cost && num(x.cost.amount) !== undefined && typeof x.cost.currency === 'string'
          ? { amount: num(x.cost.amount)!, currency: x.cost.currency }
          : undefined
      return { kind: 'usage', contextUsed: num(x.used), contextSize: num(x.size), cost }
    }
    default:
      return null
  }
}

/** A terminal entry adds nothing readable: its output comes in `_meta` or `rawOutput`. */
function toolOutput(content: acp.ToolCallContent[] | null | undefined): string | undefined {
  const parts = (content ?? []).flatMap((c) => {
    if (c.type === 'content') return [c.content.type === 'text' ? c.content.text : `[${c.content.type}]`]
    if (c.type === 'diff') return [`--- ${c.path}\n${c.newText}`]
    return []
  })
  return parts.length ? parts.join('\n') : undefined
}

/**
 * A command the agent ran itself, shown as a terminal it never asked Fenn Code to open (Qoder,
 * Claude Code's adapter): its output arrives as `_meta.terminal_output`.
 */
function terminalOutput(meta: unknown): string | undefined {
  const data = (meta as { terminal_output?: { data?: unknown } } | null | undefined)?.terminal_output?.data
  return typeof data === 'string' ? data : undefined
}

/** A tool's raw output: text blocks read as their text, anything else as JSON. */
function rawText(v: unknown): string | undefined {
  if (Array.isArray(v) && v.length && v.every((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string'))
    return v.map((b) => b.text).join('\n')
  return stringify(v)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/**
 * The turn's token usage: ACP's `usage` field, or else a vendor's `_meta.quota.token_count`
 * (Qoder). Undefined when neither carries a number, so nothing is ever made up.
 */
export function turnUsage(res: unknown, inputIncludesCache = false): TurnUsage | undefined {
  const r = (res ?? {}) as { usage?: Record<string, unknown> | null; _meta?: { quota?: { token_count?: Record<string, unknown> } } | null }
  const u = r.usage
  let out: TurnUsage = {}
  if (u && typeof u === 'object') {
    out = {
      input: num(u.inputTokens),
      output: num(u.outputTokens),
      total: num(u.totalTokens),
      thought: num(u.thoughtTokens),
      cachedRead: num(u.cachedReadTokens),
      cachedWrite: num(u.cachedWriteTokens)
    }
  } else {
    const q = r._meta?.quota?.token_count
    if (q && typeof q === 'object') out = { input: num(q.input_tokens), output: num(q.output_tokens) }
  }
  for (const k of Object.keys(out) as (keyof TurnUsage)[]) if (out[k] === undefined) delete out[k]
  if (!Object.keys(out).length) return undefined
  // Input is shown as new input only, the same for every agent; cache reads are listed apart.
  // The agent's own total says which way its input counts (codex-acp 2.x already takes the cache
  // out, older ones don't); only without a total does the plugin's word decide.
  if (out.input !== undefined && out.cachedRead && includesCache(out, inputIncludesCache)) out.input = Math.max(0, out.input - out.cachedRead)
  if (out.total === undefined && out.input !== undefined && out.output !== undefined) out.total = out.input + out.output
  return out
}

/** Whether a turn's input counts its cache reads: input + output make the total, rather than input + cache + output. */
function includesCache(u: TurnUsage, fallback: boolean): boolean {
  // Input smaller than its cache reads can't contain them, whatever the plugin says.
  if (u.total === undefined || u.output === undefined) return fallback && u.input! >= (u.cachedRead ?? 0)
  const plain = u.input! + u.output
  const split = plain + (u.cachedRead ?? 0) + (u.cachedWrite ?? 0)
  if (Math.abs(u.total - plain) <= Math.abs(u.total - split)) return u.input! >= (u.cachedRead ?? 0)
  return false
}

function normalizeStop(r: string): TurnResult['stopReason'] {
  return r === 'end_turn' || r === 'cancelled' || r === 'max_tokens' || r === 'max_turn_requests' || r === 'refusal' ? r : 'end_turn'
}

function stringify(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { message: string; data?: unknown }
    return e.data ? `${e.message}: ${stringify(e.data)}` : e.message
  }
  return String(err)
}
