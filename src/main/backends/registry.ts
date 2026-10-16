/**
 * Collects every available backend plugin.
 *
 * Built-in plugins: any file in ./plugins/ whose default export is a
 * BackendPlugin is picked up automatically, so adding a backend means adding
 * one file there. Users can also declare extra ACP agents without code, in
 * `backends.json` in the app's data folder:
 *
 *   [{ "id": "my-agent", "name": "My Agent", "command": "my-agent", "args": ["--acp"] }]
 */
import { existsSync, readFileSync } from 'node:fs'
import type { BackendPlugin } from '../../shared/contract'
import { acpPlugin } from './acp'
import { t, tk } from '../../shared/i18n'
import { demoAgentEnabled } from '../demo'
import { findOnPath } from './install'
import { readQoderCredits } from './qoderCredits'

const builtins = import.meta.glob<{ default: BackendPlugin }>('./plugins/*.ts', { eager: true })
// Vite removes this branch and the test plugin from production builds.
const testPlugins = import.meta.env.DEV
  ? import.meta.glob<{ default: BackendPlugin }>('./testing/*.ts', { eager: true }) : {}

export interface DeclaredAcpBackend {
  id: string
  name: string
  description?: string
  command: string
  args?: string[]
  /** Fixed environment for the agent. Put secrets in `settings` instead. */
  env?: Record<string, string>
  /**
   * Values the user fills in under 设置 → Agent 后端 (API keys are stored
   * encrypted) and that reach the agent as environment variables of the same name.
   */
  settings?: { key: string; label?: string; secret?: boolean; placeholder?: string; help?: string }[]
  /** The agent supports signing in from the app (ACP authenticate). */
  signIn?: boolean
  /** A terminal command that signs in, e.g. { "command": "qodercli", "args": ["login"] }. */
  login?: { command: string; args?: string[] }
  /**
   * How to upgrade the agent's program from settings, e.g.
   * { "run": { "command": "npm", "args": ["install", "-g", "my-agent@latest"] },
   *   "latest": { "command": "npm", "args": ["view", "my-agent", "version"] } }
   */
  upgrade?: { run: { command: string; args?: string[] }; latest?: { command: string; args?: string[] } }
}

/** Built-in agents in the order they are offered; the first installed one is suggested. */
export const PREFERRED_BACKENDS = ['codex', 'claude-code', 'grok', 'qoder']

/** backends.json is broken; the message says where. */
export class BackendsConfigError extends Error {}

/**
 * Built-in plugins plus those declared in backends.json. Throws
 * BackendsConfigError when the file can't be used, so the caller can keep
 * the last good list instead of silently losing every custom backend.
 */
export function loadPlugins(userConfigFile?: string): BackendPlugin[] {
  const plugins = new Map<string, BackendPlugin>()
  const rank = (id: string) => (PREFERRED_BACKENDS.indexOf(id) + 1 || PREFERRED_BACKENDS.length + 1)
  const ordered = Object.values({ ...builtins, ...testPlugins }).map((m) => m.default).sort((a, b) => rank(a.id) - rank(b.id))
  for (const p of ordered) if (!p.testOnly || demoAgentEnabled()) plugins.set(p.id, p)
  for (const decl of readDeclared(userConfigFile)) {
    const settings = (decl.settings ?? []).map((x) => ({ ...x, label: x.label ?? x.key }))
    plugins.set(
      decl.id,
      acpPlugin({
        id: decl.id,
        name: decl.name,
        description: decl.description ?? tk('在 backends.json 中声明'),
        settings,
        signIn: decl.signIn,
        login: decl.login,
        upgrade: decl.upgrade,
        quirks: decl.id === 'qoder' ? { hideNoneReasoning: true } : undefined,
        credits: decl.id === 'qoder' ? (config) => readQoderCredits({ ...decl.env, ...config,
          ...(decl.args?.length === 2 && /\.[cm]?js$/i.test(decl.args[0]) && decl.args[1] === '--acp'
            ? { QODER_NODE_PATH: decl.command, QODER_CLI_PATH: decl.args[0] }
            : { QODER_CLI_PATH: decl.command }) }) : undefined,
        // Same declaration → same signature, so a reload leaves that agent running.
        signature: JSON.stringify(decl),
        isInstalled: () => !!findOnPath(decl.command),
        launch: ({ config }) => ({
          command: decl.command,
          args: decl.args ?? [],
          env: { ...decl.env, ...Object.fromEntries(settings.map((x) => [x.key, config[x.key]])) }
        })
      })
    )
  }
  return [...plugins.values()]
}

/** Only the built-in plugins (when backends.json is unusable at startup). */
export function builtinPlugins(): BackendPlugin[] {
  return loadPlugins()
}

/**
 * Where a JSON text first goes wrong, as 「第 L 行第 C 列」. JSON.parse's own
 * messages differ between engines and often omit the position, so this walks
 * the text with a small validating parser.
 */
export function jsonErrorAt(text: string): string {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }
  const fail = (): never => {
    throw i
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') fail()
        str()
        ws()
        if (text[i] !== ':') fail()
        i++
        value()
        ws()
        if (text[i] === ',') i++
        else if (text[i] === '}') return void i++
        else fail()
      }
    } else if (c === '[') {
      i++
      ws()
      if (text[i] === ']') return void i++
      for (;;) {
        value()
        ws()
        if (text[i] === ',') i++
        else if (text[i] === ']') return void i++
        else fail()
      }
    } else if (c === '"') str()
    else {
      const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i))
      if (!m) fail()
      i += m![0].length
    }
  }
  const str = () => {
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\n') fail()
      i += text[i] === '\\' ? 2 : 1
    }
    if (i >= text.length) fail()
    i++
  }
  try {
    value()
    ws()
    if (i < text.length) fail()
    return ''
  } catch (pos) {
    if (typeof pos !== 'number') return ''
    const before = text.slice(0, pos)
    const line = before.split('\n').length
    const col = pos - before.lastIndexOf('\n')
    return t('第 {0} 行第 {1} 列', line, col)
  }
}

export function readDeclared(file?: string): DeclaredAcpBackend[] {
  if (!file || !existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  if (!text.trim()) return []
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const at = jsonErrorAt(text)
    const hint = /,\s*[\]}]/.test(text) ? t('（常见原因：最后一项后面多了逗号）') : ''
    throw new BackendsConfigError(
      t('backends.json {0}有格式错误{1}。', at ? t('{0}附近', at) : '', hint) + '\n' + t('详情：{0}', msg.slice(0, 160))
    )
  }
  if (!Array.isArray(list)) throw new BackendsConfigError(t('backends.json 应该是一个列表，用 [ ] 包起来。'))
  const seen = new Set<string>()
  return list.map((d, i) => {
    const n = t('backends.json 第 {0} 项', i + 1)
    if (!d || typeof d !== 'object') throw new BackendsConfigError(t('{0}应该是 { } 形式的对象。', n))
    const o = d as Record<string, unknown>
    for (const k of ['id', 'name', 'command'] as const)
      if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new BackendsConfigError(t('{0}缺少 "{1}"（文字）。', n, k))
    if (!/^[\w.-]+$/.test(o.id as string)) throw new BackendsConfigError(t('{0}的 id 只能用字母、数字、- 和 _。', n))
    if (seen.has(o.id as string)) throw new BackendsConfigError(t('{0}的 id「{1}」和前面的重复了。', n, o.id))
    seen.add(o.id as string)
    if (o.args !== undefined && !(Array.isArray(o.args) && o.args.every((a) => typeof a === 'string')))
      throw new BackendsConfigError(t('{0}的 "args" 应该是文字列表，例如 ["--acp"]。', n))
    if (o.env !== undefined && (typeof o.env !== 'object' || Array.isArray(o.env) || Object.values(o.env as object).some((v) => typeof v !== 'string')))
      throw new BackendsConfigError(t('{0}的 "env" 应该是 { "名字": "值" } 形式。', n))
    if (o.settings !== undefined && !(Array.isArray(o.settings) && o.settings.every((x) => x && typeof x.key === 'string')))
      throw new BackendsConfigError(t('{0}的 "settings" 应该是列表，每项至少有 "key"。', n))
    const login = o.login as { command?: unknown; args?: unknown } | undefined
    if (login !== undefined && !(login && typeof login.command === 'string' && (login.args === undefined || (Array.isArray(login.args) && login.args.every((a) => typeof a === 'string')))))
      throw new BackendsConfigError(t('{0}的 "login" 应该是 { "command": "…", "args": ["login"] } 形式。', n))
    const isCmd = (c: unknown) => {
      const x = c as { command?: unknown; args?: unknown } | null | undefined
      return !!x && typeof x.command === 'string' && (x.args === undefined || (Array.isArray(x.args) && x.args.every((a) => typeof a === 'string')))
    }
    const up = o.upgrade as { run?: unknown; latest?: unknown } | undefined
    if (up !== undefined && !(up && isCmd(up.run) && (up.latest === undefined || isCmd(up.latest))))
      throw new BackendsConfigError(t('{0}的 "upgrade" 应该是 { "run": { "command": "…", "args": […] }, "latest": { … } } 形式（latest 可省略）。', n))
    return o as unknown as DeclaredAcpBackend
  })
}

/** What a new backends.json shows, and what settings offers to copy. */
export const BACKENDS_EXAMPLE = `[
  {
    "id": "my-agent",
    "name": "My Agent",
    "command": "my-agent-cli",
    "args": ["--acp"],
    "settings": [{ "key": "MY_AGENT_API_KEY", "label": "API Key", "secret": true }]
  }
]`
