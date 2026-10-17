/**
 * Owns backend instances and routes contract calls to them.
 * Knows nothing about any particular protocol; it only sees BackendPlugin.
 */
import { randomUUID } from 'node:crypto'
import type {
  AccountStatus,
  CreditQuota,
  SessionOption,
  AuthMethod,
  AgentBackend,
  AgentEvent,
  BackendPlugin,
  BackendSummary,
  HostEvent,
  HostToolServer,
  PermissionDecision,
  PermissionRequest,
  PromptPart,
  SessionInfo,
  TurnResult,
  SessionContext
} from '../../shared/contract'

import { existsSync } from 'node:fs'
import { t } from '../../shared/i18n'
import { classifyError } from '../../shared/errors'
import { addToPath, latestVersion, npmGlobalBin, runStreaming } from './upgrade'

export interface SettingsStore {
  get(backendId: string): Record<string, string>
  set(backendId: string, key: string, value: string): void
}

export interface ManagerOptions {
  plugins: BackendPlugin[]
  settings: SettingsStore
  resourcesDir: string
  nodeCommand: { command: string; env: Record<string, string> }
  defaultCwd: string
  emit(e: HostEvent): void
  /** Whether the user may make this folder a conversation's working folder. */
  canWorkIn?(path: string): boolean
}

export class BackendManager {
  private instances = new Map<string, AgentBackend>()
  private permissionWaiters = new Map<string, (d: PermissionDecision) => void>()
  private lostListeners = new Set<(backendId: string) => void>()
  /** Lets internal callers (e.g. the project orchestrator) observe agent events. */
  private agentListeners = new Set<(backendId: string, sessionId: string, e: AgentEvent) => void>()

  /**
   * Backends whose last turn failed because their sign-in could not be renewed.
   * Their own status command may still say signed in, so Settings is told otherwise.
   */
  private staleSignIn = new Set<string>()

  constructor(private readonly opts: ManagerOptions) {}

  list(): BackendSummary[] {
    return this.opts.plugins.map((p) => {
      const cfg = this.opts.settings.get(p.id)
      return {
        id: p.id,
        name: t(p.name),
        installed: p.isInstalled?.(cfg),
        optionPolicy: p.optionPolicy,
        description: p.description && t(p.description),
        settings: (p.settings ?? []).map((s) => ({ ...s, label: t(s.label), help: s.help && t(s.help) })),
        configured: Object.fromEntries((p.settings ?? []).map((s) => [s.key, !!cfg[s.key]])),
        signIn: p.signIn,
        terminalLogin: !!p.login,
        account: !!p.account,
        credits: !!p.credits,
        upgrade: !!p.upgrade,
        upgradeInstallOnly: p.upgrade?.installOnly,
        upgradeCommands: p.upgrade && [p.upgrade.run, ...(p.upgrade.after ? [p.upgrade.after] : [])].map(commandLine),
        upgradeNote: p.upgrade?.after && t(p.upgrade.after.label, ...(p.upgrade.after.labelArgs ?? [])),
        images: this.instances.get(p.id)?.acceptsImages?.()
      }
    })
  }

  /** Whether this backend's agent accepts images; undefined while unknown (not started yet). */
  acceptsImages(id: string): boolean | undefined {
    return this.instances.get(id)?.acceptsImages?.()
  }

  has(id: string): boolean {
    return this.opts.plugins.some((p) => p.id === id)
  }

  async setSetting(backendId: string, key: string, value: string): Promise<void> {
    this.opts.settings.set(backendId, key, value)
    // Restart so the new settings take effect on the next call.
    await this.restart(backendId, t('{0} 的设置已更改，已重新启动。请点「重试」。', this.nameOf(backendId)))
  }

  nameOf(backendId: string): string {
    return this.opts.plugins.find((p) => p.id === backendId)?.name ?? backendId
  }

  /** Stops the backend's process; it starts again on next use. `reason` is what a running reply shows. */
  async restart(backendId: string, reason?: string): Promise<void> {
    // A restart follows signing in again (or new settings); let the status command speak again.
    this.staleSignIn.delete(backendId)
    this.dropPermissions(backendId)
    await this.instances.get(backendId)?.dispose(reason)
    this.instances.delete(backendId)
    for (const fn of this.lostListeners) fn(backendId)
  }

  /**
   * Swaps in a new plugin list (e.g. after backends.json was edited). Only
   * backends whose definition changed (or that were removed) are stopped, so
   * replies running on the others carry on; stopped ones restart on next use.
   */
  async setPlugins(plugins: BackendPlugin[]): Promise<string[]> {
    const old = new Map(this.opts.plugins.map((p) => [p.id, p]))
    const same = (a?: BackendPlugin, b?: BackendPlugin) => !!a && !!b && (a === b || (!!a.signature && a.signature === b.signature))
    // Keep the old plugin object for unchanged entries so identity checks stay meaningful.
    this.opts.plugins = plugins.map((p) => (same(p, old.get(p.id)) ? old.get(p.id)! : p))
    const restarted: string[] = []
    for (const [id] of [...this.instances]) {
      const next = plugins.find((p) => p.id === id)
      if (same(next, old.get(id))) continue
      restarted.push(id)
      this.dropPermissions(id)
      const name = old.get(id)?.name ?? id
      await this.instances
        .get(id)
        ?.dispose(next ? t('{0} 的配置已更改，已重新启动。请点「重试」。', name) : t('{0} 已从 backends.json 中移除，回复已停止。', name))
      this.instances.delete(id)
      for (const fn of this.lostListeners) fn(id)
    }
    return restarted
  }

  /** The plugin's terminal sign-in command, if it has one. */
  loginCommand(backendId: string): { command: string; args: string[] } | undefined {
    const spec = this.opts.plugins.find((p) => p.id === backendId)?.login
    const l = typeof spec === 'function' ? spec(this.opts.settings.get(backendId)) : spec
    return l && { command: l.command, args: l.args ?? [] }
  }

  onSessionsLost(fn: (backendId: string) => void): () => void {
    this.lostListeners.add(fn)
    return () => this.lostListeners.delete(fn)
  }

  onAgentEvent(fn: (backendId: string, sessionId: string, e: AgentEvent) => void): () => void {
    this.agentListeners.add(fn)
    return () => this.agentListeners.delete(fn)
  }

  private get(backendId: string): AgentBackend {
    let inst = this.instances.get(backendId)
    if (inst) return inst
    const plugin = this.opts.plugins.find((p) => p.id === backendId)
    if (!plugin)
      throw new Error(
        t('后端「{0}」已经不存在了（可能从 backends.json 里删掉了，或者那个文件有错）。请在输入框下方换一个后端，或者修好 backends.json 后点「重新加载」。', backendId)
      )
    inst = plugin.create({
      config: this.opts.settings.get(backendId),
      resourcesDir: this.opts.resourcesDir,
      nodeCommand: this.opts.nodeCommand,
      canWorkIn: (path) => !!this.opts.canWorkIn?.(path),
      emit: (sessionId, event) => {
        for (const fn of this.agentListeners) fn(backendId, sessionId, event)
        this.opts.emit({ type: 'agent', backendId, sessionId, event })
      },
      requestPermission: (req) => this.askPermission(backendId, req),
      sessionsLost: () => {
        this.dropPermissions(backendId)
        for (const fn of this.lostListeners) fn(backendId)
      },
      log: (level, message) => {
        if (level !== 'debug') console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'](message)
        this.opts.emit({ type: 'backend-log', backendId, level, message })
      }
    })
    this.instances.set(backendId, inst)
    return inst
  }

  async newSession(backendId: string, opts: { cwd?: string; folder?: string; tools?: HostToolServer[]; system?: string } = {}): Promise<SessionInfo> {
    return this.signedInSince(backendId, () =>
      this.get(backendId).newSession({ cwd: opts.cwd || this.opts.defaultCwd, folder: opts.folder, tools: opts.tools, system: opts.system }))
  }

  /** Replies running now, per backend: a restart would stop them. */
  private prompting = new Map<string, number>()

  /**
   * An agent that read its sign-in when it started (Qoder) doesn't see one made since, in a
   * terminal or another app: when it says signed out and nothing is running on it, start it
   * again and ask once more.
   */
  private async signedInSince<T>(backendId: string, open: () => Promise<T>): Promise<T> {
    try {
      return await open()
    } catch (err) {
      const kind = classifyError(err instanceof Error ? err.message : String(err))
      if ((kind !== 'auth' && kind !== 'refresh') || this.prompting.get(backendId)) throw err
      await this.restart(backendId)
      return open()
    }
  }

  /** Starts the agent ahead of the first message; sends nothing. */
  warm(backendId: string): Promise<void> {
    return this.get(backendId).warm?.(this.opts.defaultCwd) ?? Promise.resolve()
  }

  /** No prompt or app tools: discover the models a new session actually offers. */
  async modelCatalog(backendId: string, modelId?: string): Promise<Omit<SessionInfo, 'sessionId'>> {
    const { sessionId, ...catalog } = await this.signedInSince(backendId, () => this.get(backendId).newSession({ cwd: this.opts.defaultCwd }))
    const backend = this.get(backendId)
    const off = this.onAgentEvent((bid, sid, event) => {
      if (bid === backendId && sid === sessionId && event.kind === 'options') catalog.options = event.options
    })
    try {
      if (modelId && modelId !== catalog.currentModelId && catalog.models?.some((m) => m.id === modelId)) {
        await backend.setModel?.(sessionId, modelId)
        catalog.currentModelId = modelId
      }
      return catalog
    } finally {
      off()
      // Not awaited: removing it from the agent's history must not hold up the model list.
      void backend.closeSession?.(sessionId, { discard: true }).catch(() => {})
    }
  }

  async resumeSession(
    backendId: string,
    sessionId: string,
    opts: { cwd?: string; folder?: string; tools?: HostToolServer[]; system?: string } = {}
  ): Promise<SessionInfo | null> {
    const b = this.get(backendId)
    if (!b.resumeSession) return null
    return b.resumeSession({ sessionId, cwd: opts.cwd || this.opts.defaultCwd, folder: opts.folder, tools: opts.tools, system: opts.system })
  }

  async prompt(backendId: string, sessionId: string, parts: PromptPart[]): Promise<TurnResult> {
    this.prompting.set(backendId, (this.prompting.get(backendId) ?? 0) + 1)
    const r = await this.get(backendId).prompt(sessionId, parts).finally(() => this.prompting.set(backendId, this.prompting.get(backendId)! - 1))
    if (r.stopReason === 'error' && classifyError(r.error) === 'refresh') this.staleSignIn.add(backendId)
    else if (r.stopReason !== 'error') this.staleSignIn.delete(backendId)
    return r
  }

  cancel(backendId: string, sessionId: string): Promise<void> {
    return this.get(backendId).cancel(sessionId)
  }

  async stopCommand(backendId: string, sessionId: string, id: string): Promise<boolean> {
    return (await this.get(backendId).stopCommand?.(sessionId, id)) ?? false
  }

  async commandOutput(backendId: string, sessionId: string, id: string): Promise<string | undefined> {
    return this.get(backendId).commandOutput?.(sessionId, id)
  }

  async authMethods(backendId: string): Promise<AuthMethod[]> {
    this.notUpgrading(backendId)
    return (await this.get(backendId).authMethods?.()) ?? []
  }

  async authenticate(backendId: string, methodId: string): Promise<void> {
    this.notUpgrading(backendId)
    const b = this.get(backendId)
    if (!b.authenticate) throw new Error(t('这个后端不支持在应用里登录'))
    await b.authenticate(methodId)
  }

  async setModel(backendId: string, sessionId: string, modelId: string): Promise<void> {
    await this.get(backendId).setModel?.(sessionId, modelId)
  }

  async setOption(backendId: string, sessionId: string, optionId: string, value: string): Promise<SessionOption[] | undefined> {
    return this.get(backendId).setOption?.(sessionId, optionId, value)
  }

  /** The sign-in state, if the backend can tell without a session; {} when unknown. */
  async account(backendId: string): Promise<AccountStatus> {
    const p = this.opts.plugins.find((x) => x.id === backendId)
    // No account check (Antigravity): whether its program is there still says 未安装 or not.
    if (!p?.account) return p?.isInstalled ? { installed: p.isInstalled(this.opts.settings.get(backendId)) } : {}
    return p
      .account(this.opts.settings.get(backendId))
      .then((a) => (a.detail ? { ...a, detail: t(a.detail) } : a))
      .then((a) =>
        a.signedIn && this.staleSignIn.has(backendId)
          ? { ...a, signedIn: false, detail: [t('需要重新登录'), a.detail].filter(Boolean).join(' · ') }
          : a
      )
      .catch(() => ({}))
  }

  private creditReads = new Map<string, { key: string; at: number; value: Promise<CreditQuota | undefined> }>()

  async credits(backendId: string, refresh = false): Promise<CreditQuota | undefined> {
    const plugin = this.opts.plugins.find((p) => p.id === backendId)
    if (!plugin?.credits) return undefined
    const config = this.opts.settings.get(backendId)
    const key = JSON.stringify([plugin.signature, config])
    const cached = this.creditReads.get(backendId)
    if (!refresh && cached?.key === key && Date.now() - cached.at < 15_000) return cached.value
    const value = plugin.credits(config).catch(() => undefined)
    this.creditReads.set(backendId, { key, at: Date.now(), value })
    return value
  }

  /** How full a session's context is, from the agent CLI's own log (read-only). */
  async sessionContext(backendId: string, sessionId: string): Promise<SessionContext | undefined> {
    const plugin = this.opts.plugins.find((p) => p.id === backendId)
    return plugin?.sessionContext?.(sessionId).catch(() => undefined)
  }

  /** The latest version of the backend's program, if the plugin can tell. */
  async latestVersion(backendId: string): Promise<string | undefined> {
    const spec = this.opts.plugins.find((x) => x.id === backendId)?.upgrade?.latest
    return spec ? latestVersion(spec) : undefined
  }

  /** Backends whose program is being installed or replaced: they can't start or sign in meanwhile. */
  private upgrading = new Set<string>()

  private notUpgrading(backendId: string): void {
    if (this.upgrading.has(backendId)) throw new Error(t('{0} 正在安装或升级，完成后再试。', this.nameOf(backendId)))
  }

  /**
   * Upgrades the backend's program with its own command. The backend is stopped
   * first (a program can't always be replaced while it runs); it starts again on next use.
   */
  async upgrade(backendId: string, onLine: (line: string) => void): Promise<{ ok: boolean; output: string }> {
    const spec = this.opts.plugins.find((x) => x.id === backendId)?.upgrade
    if (!spec) throw new Error(t('{0} 不支持在应用里升级。', this.nameOf(backendId)))
    this.notUpgrading(backendId)
    if (this.instances.has(backendId)) await this.restart(backendId, t('正在升级 {0}，这条回复已停止。升级完成后请点「重试」。', this.nameOf(backendId)))
    this.upgrading.add(backendId)
    let r: { ok: boolean; output: string }
    try {
      await spec.before?.()
      onLine(`> ${[spec.run.command, ...(spec.run.args ?? [])].join(' ')}`)
      r = await runStreaming(spec.run, onLine)
      if (r.ok && spec.after) {
        onLine(`> ${t(spec.after.label, ...(spec.after.labelArgs ?? []))}`)
        const a = await runStreaming(spec.after, onLine)
        r = { ok: a.ok, output: r.output + a.output }
      }
    } finally {
      this.upgrading.delete(backendId)
    }
    // npm may install into a folder this app's PATH doesn't have yet (e.g. Node was installed
    // after the app started). Add it, so the program is found without restarting.
    if (r.ok && spec.run.command === 'npm') {
      const bin = await npmGlobalBin()
      if (bin && existsSync(bin)) addToPath(bin)
    }
    return r
  }

  /**
   * One-off question in a fresh session; resolves with the reply text.
   * Used for background chores (classification, titles) that the user does not see.
   */
  async ask(backendId: string, text: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<string> {
    const backend = this.get(backendId)
    const { sessionId } = await backend.newSession({ cwd: opts.cwd || this.opts.defaultCwd })
    let out = ''
    const off = this.onAgentEvent((b, s, e) => {
      if (b === backendId && s === sessionId && e.kind === 'message.delta') out += e.text
    })
    this.backgroundSessions.add(`${backendId}:${sessionId}`)
    try {
      const turn = backend.prompt(sessionId, [{ type: 'text', text }])
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('timeout')), opts.timeoutMs ?? 60_000)
      )
      const res = await Promise.race([turn, timeout])
      if (res.stopReason === 'error') throw new Error(res.error)
      return out.trim()
    } finally {
      off()
      this.backgroundSessions.delete(`${backendId}:${sessionId}`)
      // Background chores leave nothing behind in the agent.
      void backend.closeSession?.(sessionId, { discard: true }).catch(() => {})
    }
  }

  /** Background sessions never prompt the user; permission requests are declined. */
  private backgroundSessions = new Set<string>()

  respondPermission(requestId: string, decision: PermissionDecision): void {
    this.permissionWaiters.get(requestId)?.(decision)
    this.permissionWaiters.delete(requestId)
  }

  /** Pending prompts from a backend that went away can never be answered: dismiss them. */
  private dropPermissions(backendId: string): void {
    for (const [id, w] of this.permissionWaiters) {
      if (this.permissionOwner.get(id) === backendId) {
        w(null)
        this.permissionWaiters.delete(id)
        this.permissionOwner.delete(id)
        this.opts.emit({ type: 'permission-dropped', backendId, requestId: id })
      }
    }
  }

  private permissionOwner = new Map<string, string>()

  private askPermission(backendId: string, req: Omit<PermissionRequest, 'requestId'>): Promise<PermissionDecision> {
    if (this.backgroundSessions.has(`${backendId}:${req.sessionId}`)) {
      const reject = req.options.find((o) => o.kind.startsWith('reject'))
      return Promise.resolve(reject?.id ?? null)
    }
    const request: PermissionRequest = { ...req, requestId: randomUUID() }
    return new Promise((resolve) => {
      this.permissionWaiters.set(request.requestId, resolve)
      this.permissionOwner.set(request.requestId, backendId)
      this.opts.emit({ type: 'permission', backendId, request })
    })
  }

  async disposeAll(): Promise<void> {
    for (const id of this.instances.keys()) this.dropPermissions(id)
    await Promise.all([...this.instances.values()].map((i) => i.dispose()))
    this.instances.clear()
  }
}

/** A command as it would be typed, quoting arguments with spaces or line breaks, for showing before it runs. */
export function commandLine(c: { command: string; args?: string[] }): string {
  const q = (a: string) => (/[\s"'$`]/.test(a) ? `'${a.trim().replace(/'/g, `'\\''`)}'` : a)
  return [c.command, ...(c.args ?? []).map(q)].join(' ')
}
