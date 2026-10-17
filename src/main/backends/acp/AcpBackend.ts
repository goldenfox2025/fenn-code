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
import { join } from 'node:path'
import { Workspaces } from '../workspace'
import { t } from '../../../shared/i18n'
import { classifyError } from '../../../shared/errors'
import { visibleSessionOptions } from '../../../shared/sessionOptions'
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
  translateExt?(method: string, params: Record<string, unknown>): { sessionId: string; event: AgentEvent } | null
  /** Shown when the agent says authentication is required. */
  authHint?: string
  /** Shown when the agent's program can't be found (instead of a bare ENOENT). */
  missingHint?: string
  /**
   * The agent's reported input already counts cache reads (OpenAI-style: Codex,
   * Grok). Anthropic-style input (Claude Code) does not.
   */
  inputIncludesCache?: boolean
}

interface ModelSelector {
  configId?: string
  models: ModelInfo[]
  current?: string
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
  /** Each session's non-model choices; `legacy` marks ACP session modes (set with session/set_mode). */
  private sessionOptions = new Map<string, (SessionOption & { legacy?: boolean })[]>()
  private stderrTail: string[] = []
  /** Why the agent process last exited, for readable errors. */
  private exitReason?: string
  /** Why the app stopped a process on purpose, shown instead of its raw exit signal. */
  private stopReasons = new WeakMap<object, string>()
  private caps?: acp.AgentCapabilities
  private auth: AuthMethod[] = []
  /** Sessions being loaded: history the agent replays must not reach the app. */
  private replaying = new Set<string>()
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
    this.workspaces = new Workspaces(async (sessionId, title, detail) => {
      const d = await this.host.requestPermission({
        sessionId,
        title,
        detail,
        options: [
          { id: 'allow', label: t('允许'), kind: 'allow_once' },
          { id: 'reject', label: t('拒绝'), kind: 'reject_once' }
        ]
      })
      return d === 'allow'
    })}

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
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (chunk: string) => {
      this.stderrTail.push(chunk)
      if (this.stderrTail.length > 40) this.stderrTail.shift()
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
        this.starting = undefined
        // Through a shell (Windows .cmd), a missing program shows up as an exit, not ENOENT.
        this.exitReason = /is not recognized as an internal or external command|command not found/i.test(this.stderrTail.join(''))
          ? this.missing(spec.command)
          : this.stopReasons.get(proc) ?? t('{0} 已退出（{1}）', this.name, signal ?? `code ${code}`) + tail(this.stderrTail)
        reject(new Error(this.exitReason))
        // Sessions lived in that process; tell the app so it can start over cleanly.
        if (!wasUs) this.host.sessionsLost()
      })
    })
    exited.catch(() => {})

    // Both directions pass through the opt-in debug log (a no-op while it is off).
    const toAgent = tap(this.name, 'out')
    toAgent.readable.pipeTo(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>).catch(() => {})
    const stream = acp.ndJsonStream(
      toAgent.writable,
      (Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>).pipeThrough(tap(this.name, 'in'))
    )
    this.conn = new acp.ClientSideConnection(() => this.clientHandler(), stream)

    const init = await Promise.race([
      this.conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        // compaction: the agent says when it compacted, so the app can hand its notes over again.
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, session: { compaction: {} } } as acp.ClientCapabilities,
        clientInfo: { name: 'ancora', version: '0.1.0' }
      }),
      exited
    ])
    this.caps = init.agentCapabilities ?? undefined
    this.auth = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name, description: m.description ?? undefined }))
    this.host.log('info', `${this.name} initialized (protocol v${init.protocolVersion})`)
  }

  private clientHandler(): acp.Client {
    return {
      sessionUpdate: async ({ sessionId, update }) => {
        if (this.replaying.has(sessionId)) return
        const ev = translateUpdate(update)
        if (ev) this.host.emit(sessionId, ev)
        if (update.sessionUpdate === 'compaction_update') {
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
        const decision = await this.host.requestPermission({
          sessionId,
          title: toolCall.title ?? t('工具调用'),
          detail: stringify(toolCall.rawInput),
          options: options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind }))
        })
        return decision
          ? { outcome: { outcome: 'selected', optionId: decision } }
          : { outcome: { outcome: 'cancelled' } }
      },
      readTextFile: async ({ sessionId, path, line, limit }) => ({
        content: await this.workspaces.readTextFile(sessionId, path, line, limit)
      }),
      writeTextFile: async ({ sessionId, path, content }) => {
        await this.workspaces.writeTextFile(sessionId, path, content)
        return {}
      },
      createTerminal: async (req) => ({ terminalId: await this.workspaces.createTerminal(req.sessionId, req) }),
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
        if (t) this.host.emit(t.sessionId, t.event)
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
          env: env({ ...this.host.nodeCommand.env, ANCORA_BRIDGE_HEADERS: JSON.stringify(t.headers ?? {}) })
        }
      ]
    })
  }

  async closeSession(sessionId: string): Promise<void> {
    this.workspaces.close(sessionId)
    this.modelSelectors.delete(sessionId)
    this.sessionOptions.delete(sessionId)
    if (!this.caps?.sessionCapabilities?.close) return
    await this.conn?.closeSession({ sessionId }).catch(() => {})
  }

  async resumeSession({ cwd, folder, tools, sessionId, system }: NewSessionOptions & { sessionId: string }): Promise<SessionInfo | null> {
    await this.start()
    this.workspaces.setRoot(sessionId, folder)
    const mcpServers = this.mcpServers(tools)
    let res: { configOptions?: unknown; models?: unknown; _meta?: Record<string, unknown> | null } | undefined
    try {
      if (this.caps?.sessionCapabilities?.resume) {
        res = await this.conn!.resumeSession({ sessionId, cwd, mcpServers, ...this.systemPrompt(system) } as acp.ResumeSessionRequest)
      } else if (this.caps?.loadSession) {
        this.replaying.add(sessionId)
        try {
          res = await this.conn!.loadSession({ sessionId, cwd, mcpServers, ...this.systemPrompt(system) } as acp.LoadSessionRequest)
        } finally {
          this.replaying.delete(sessionId)
        }
      } else return null
    } catch (err) {
      this.host.log('warn', `${this.name} could not resume ${sessionId}: ${errorText(err)}`)
      return null
    }
    this.captureModels(sessionId, res?.configOptions, res?._meta?.modelState ?? res?.models)
    this.captureOptions(sessionId, res?.configOptions, (res as { modes?: unknown } | undefined)?.modes)
    const sel = this.modelSelectors.get(sessionId)
    return { sessionId, models: sel?.models, currentModelId: sel?.current, options: this.optionsOf(sessionId), systemApplied: this.takesSystemPrompt(system) }
  }

  /** The agent accepts a client system prompt (ACP sessionCapabilities.systemPrompt), which survives its compaction. */
  private takesSystemPrompt(system?: string): boolean {
    return !!system && !!(this.caps?.sessionCapabilities as { systemPrompt?: unknown } | undefined)?.systemPrompt
  }

  private systemPrompt(system?: string): { systemPrompt?: { mode: 'append'; content: { type: 'text'; text: string }[] } } {
    return this.takesSystemPrompt(system) ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: system! }] } } : {}
  }

  async newSession({ cwd, folder, tools, system }: NewSessionOptions): Promise<SessionInfo> {
    await this.start()
    const mcpServers = this.mcpServers(tools)
    let res: acp.NewSessionResponse
    try {
      res = await this.conn!.newSession({ cwd, mcpServers, ...this.systemPrompt(system) } as acp.NewSessionRequest)
    } catch (err) {
      const msg = errorText(err)
      if (classifyError(msg) === 'auth' || classifyError(msg) === 'refresh') {
        const login = this.auth.length ? t('可以在 设置 → Agent 后端 里点「登录」。') : ''
        throw new Error(`${t('{0} 需要登录。', this.name)}${this.quirks.authHint ? t(this.quirks.authHint) : login}`.trim())
      }
      throw new Error(msg)
    }
    this.workspaces.setRoot(res.sessionId, folder)
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

  /** Maps prompt parts to ACP content, degrading gracefully to what the agent accepts. */
  private toContent(sessionId: string, parts: PromptPart[]): acp.ContentBlock[] {
    const caps = this.caps?.promptCapabilities
    const out: acp.ContentBlock[] = []
    for (const p of parts) {
      if (p.type === 'text') out.push({ type: 'text', text: p.text })
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
    if (opt.legacy) {
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
    return list?.length ? list.map(({ legacy: _legacy, ...o }) => ({ ...o, choices: o.choices.map((c) => ({ ...c })) })) : undefined
  }

  private emitOptions(sessionId: string): void {
    this.host.emit(sessionId, { kind: 'options', options: this.optionsOf(sessionId) ?? [] })
  }

  /**
   * Every select the agent offers besides the model (config options), or its
   * session modes when it has no config options. Unknown shapes are skipped.
   */
  private captureOptions(sessionId: string, configOptions: unknown, modes: unknown): void {
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
    p?.kill()
    this.conn = undefined
    this.starting = undefined
  }

  private captureModels(sessionId: string, configOptions: unknown, legacy: unknown): void {
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

function tail(lines: string[]): string {
  const t = lines.join('').trim().split('\n').slice(-6).join('\n').slice(-600)
  return t ? `：\n${t}` : ''
}

/**
 * On Windows, commands like `npx` are .cmd shims that need a shell, but going
 * through a shell splits unquoted paths with spaces. Use the shell only for
 * bare command names and .cmd/.bat files, and quote arguments when we do.
 */
export function windowsSafe(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32') return { command, args, shell: false }
  const isScript = /\.(cmd|bat)$/i.test(command)
  const isBare = !/[\\/]/.test(command) && !/\.(exe|com)$/i.test(command)
  if (!isScript && !isBare) return { command, args, shell: false }
  const q = (a: string) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)
  return { command: q(command), args: args.map(q), shell: true }
}

function translateUpdate(u: acp.SessionNotification['update']): AgentEvent | null {
  switch (u.sessionUpdate) {
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
        input: stringify(u.rawInput)
      }
    case 'tool_call_update':
      return {
        kind: 'tool.update',
        toolId: u.toolCallId,
        title: u.title ?? undefined,
        status: u.status ? TOOL_STATUS[u.status] : undefined,
        output: toolOutput(u.content) ?? stringify(u.rawOutput)
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

function toolOutput(content: acp.ToolCallContent[] | null | undefined): string | undefined {
  if (!content?.length) return undefined
  return content
    .map((c) => {
      if (c.type === 'content') return c.content.type === 'text' ? c.content.text : `[${c.content.type}]`
      if (c.type === 'diff') return `--- ${c.path}\n${c.newText}`
      return `[terminal ${c.terminalId}]`
    })
    .join('\n')
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
  if (inputIncludesCache && out.input !== undefined && out.cachedRead) out.input = Math.max(0, out.input - out.cachedRead)
  if (out.total === undefined && out.input !== undefined && out.output !== undefined) out.total = out.input + out.output
  return out
}

function normalizeStop(r: string): TurnResult['stopReason'] {
  return r === 'end_turn' || r === 'cancelled' || r === 'max_tokens' || r === 'refusal' ? r : 'end_turn'
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
