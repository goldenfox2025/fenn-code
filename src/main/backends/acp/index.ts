import { execFile } from 'node:child_process'
import type { AccountStatus, BackendHost, BackendPlugin, PluginSetting, UpgradeSpec } from '../../../shared/contract'
import { findOnPath } from '../install'
import { t } from '../../../shared/i18n'
import { readSessionContext, type SessionLogKind } from '../sessionLogs'
import { AcpBackend, windowsSafe, type AcpLaunchSpec, type AcpQuirks } from './AcpBackend'
import { endTree } from '../workspace'

/** A command that reports the sign-in state, and how to read its output. */
export interface AccountCheck {
  command: string
  args?: string[]
  env?: Record<string, string | undefined>
  /** Other programs the backend needs (e.g. its ACP adapter); missing any reads as not installed. */
  requires?: string[]
  /** The program reports on stderr (and may exit non-zero when signed out): parse both streams. */
  stderr?: boolean
  parse: (stdout: string) => AccountStatus
}

export interface AcpPluginOptions {
  id: string
  name: string
  description?: string
  settings?: PluginSetting[]
  /**
   * Builds the launch command; host.config holds the user's settings for this
   * plugin. Runs when the agent is first needed, so it may install things.
   */
  launch: (host: BackendHost) => AcpLaunchSpec | Promise<AcpLaunchSpec>
  quirks?: AcpQuirks
  signIn?: boolean
  login?: BackendPlugin['login']
  signature?: string
  testOnly?: boolean
  isInstalled?: (config: Record<string, string>) => boolean
  /** How to check the sign-in state without starting a session; gets the user's settings. */
  account?: (config: Record<string, string>) => AccountCheck
  /** The sign-in state read from files the agent keeps (no program to ask); used instead of `account`. */
  accountState?: (config: Record<string, string>) => AccountStatus
  credits?: BackendPlugin['credits']
  upgrade?: UpgradeSpec
  /** Which CLI session log to read for context figures (see sessionLogs.ts). */
  sessionLog?: SessionLogKind
}

/** Runs an account check; a missing program or a failure reads as "unknown", never as an error. */
export function runAccountCheck(check: AccountCheck, timeoutMs = 30_000): Promise<AccountStatus> {
  const { command, args, shell } = windowsSafe(check.command, check.args ?? [])
  const env = { ...process.env }
  for (const [k, v] of Object.entries(check.env ?? {})) if (v !== undefined) env[k] = v
  // A bare program name that isn't on PATH is simply not installed.
  if (!/[\\/]/.test(check.command) && !findOnPath(check.command, env)) return Promise.resolve({ installed: false })
  if (check.requires?.some((p) => !findOnPath(p, env))) return Promise.resolve({ installed: false })
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, shell, windowsHide: true }, (err, stdout, stderr) => {
      clearTimeout(timer)
      if (notFound(err, String(stderr))) return resolve({ installed: false })
      const out = check.stderr ? `${stdout}\n${stderr}` : String(stdout)
      if (err && !out.trim()) return resolve({})
      try {
        resolve(check.parse(out))
      } catch {
        resolve({})
      }
    })
    // Not execFile's own timeout: on Windows that ends only cmd.exe, and the program keeps running.
    const timer = setTimeout(() => endTree(child), timeoutMs)
  })
}

/** The program itself is missing (as opposed to failing): ENOENT, or the shell saying so. */
export function notFound(err: unknown, stderr = ''): boolean {
  const e = err as { code?: unknown } | null
  if (e?.code === 'ENOENT') return true
  // Through a shell: 127 (sh), 9009 (cmd); cmd's message may be localized.
  if (e?.code === 127 || e?.code === 9009) return true
  return /is not recognized as an internal or external command|不是内部或外部命令|command not found/i.test(stderr)
}

/** Where to sign in, naming only the controls this backend actually has. */
export function authHintFor(opts: Pick<AcpPluginOptions, 'name' | 'signIn' | 'login' | 'settings'>): string {
  const ways: string[] = []
  if (opts.signIn || opts.login) ways.push(t('点「登录」'))
  const secret = opts.settings?.find((x) => x.secret)
  if (secret) ways.push(t('填写「{0}」', t(secret.label)))
  if (!ways.length) return t('请按 {0} 的说明登录后重试。', opts.name)
  return t('请在 设置 → Agent 后端 → {0} 里{1}，然后重试。', opts.name, ways.join(t('，或')))
}

/** Turns "how to start an ACP agent" into a full backend plugin. */
export function acpPlugin(opts: AcpPluginOptions): BackendPlugin {
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    settings: opts.settings,
    signIn: opts.signIn,
    credits: opts.credits,
    login: opts.login,
    signature: opts.signature,
    testOnly: opts.testOnly,
    optionPolicy: opts.quirks?.hideNoneReasoning ? { hideNoneReasoning: true } : undefined,
    isInstalled: opts.isInstalled ?? (opts.account ? (config) => {
      const check = opts.account!(config)
      const env = { ...process.env, ...Object.fromEntries(Object.entries(check.env ?? {}).filter(([, v]) => v !== undefined)) }
      return [check.command, ...(check.requires ?? [])].every((command) => !!findOnPath(command, env))
    } : undefined),
    account: opts.accountState
      ? async (config) => opts.accountState!(config)
      : opts.account
        ? (config) => runAccountCheck(opts.account!(config))
        : undefined,
    upgrade: opts.upgrade,
    sessionContext: opts.sessionLog ? (sessionId) => readSessionContext(opts.sessionLog!, sessionId) : undefined,
    create: (host: BackendHost) =>
      new AcpBackend(opts.name, () => opts.launch(host), host, { ...opts.quirks, authHint: opts.quirks?.authHint ?? authHintFor(opts) })
  }
}

export type { AcpLaunchSpec, AcpQuirks }
