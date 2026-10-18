import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { acpPlugin, type AccountCheck } from '../acp'
import { nodeScript, packageDir } from '../nodeScript'
import { t, tk } from '../../../shared/i18n'

const versionIn = (dir: string | undefined): string | undefined => {
  if (!dir) return undefined
  try {
    const v = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * The versions the app actually runs: the ACP adapter, and the Codex it ships with (what it starts,
 * unless the user named their own Codex). A global `codex` elsewhere on PATH is not what runs.
 */
export function launchedVersions(config: Record<string, string> = {}): { adapter?: string; codex?: string } {
  const spec = nodeScript(config.CODEX_ACP_PATH?.trim() || 'codex-acp', '@agentclientprotocol/codex-acp/dist/index.js', [])
  const script = spec.requires?.[0]
  if (!script) return {}
  const own = config.CODEX_CLI_PATH?.trim()
  return { adapter: versionIn(packageDir(script, '@agentclientprotocol/codex-acp')), codex: own ? undefined : versionIn(bundledCodex(script)?.root) }
}

/** `codex login status` says "Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1). */
export function codexAccount(config: Record<string, string> = {}): AccountCheck {
  const running = launchedVersions(config)
  const versions = [running.adapter && t('适配器 {0}', running.adapter), running.codex && `Codex ${running.codex}`].filter(Boolean).join(' · ')
  return {
    command: config.CODEX_CLI_PATH?.trim() || 'codex',
    args: ['login', 'status'],
    requires: [config.CODEX_ACP_PATH?.trim() || 'codex-acp'],
    stderr: true,
    parse: (out) => {
      const line = out.split(/\r?\n/).find((l) => /logged in/i.test(l))?.trim() ?? ''
      // The version is the adapter's: upgrading it is what changes the Codex that runs (it ships its own).
      const version = running.adapter
      if (/not logged in/i.test(line)) return { installed: true, signedIn: false, version, detail: versions || undefined }
      const via = /using (.+)$/i.exec(line)?.[1]
      const who = via ? (/chatgpt/i.test(via) ? t('ChatGPT 账号') : via) : ''
      return { installed: true, signedIn: line ? true : undefined, version, detail: [who, versions].filter(Boolean).join(' · ') || undefined }
    }
  }
}

const TRIPLES: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
}

/**
 * The Codex program the adapter ships with, found the way its own `codex.js` finds it. Started
 * directly, Codex skips a second Node process (codex.js) that does nothing but start it.
 */
export function bundledCodex(adapterScript: string): { exe: string; root: string } | undefined {
  const adapter = packageDir(adapterScript, '@agentclientprotocol/codex-acp')
  const triple = TRIPLES[`${process.platform}-${process.arch}`]
  if (!adapter || !triple) return undefined
  try {
    const root = dirname(createRequire(join(adapter, 'package.json')).resolve('@openai/codex/package.json'))
    const vendor = dirname(createRequire(join(root, 'package.json')).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`))
    const exe = join(vendor, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
    return existsSync(exe) ? { exe, root: realpathSync(root) } : undefined
  } catch {
    return undefined
  }
}

/** codex-acp as `node <its script>` (no .cmd shim), with Codex itself started directly. */
export function codexLaunch(config: Record<string, string>): { command: string; args: string[]; env: Record<string, string | undefined> } {
  const spec = nodeScript(config.CODEX_ACP_PATH?.trim() || 'codex-acp', '@agentclientprotocol/codex-acp/dist/index.js', [])
  const own = config.CODEX_CLI_PATH?.trim()
  const bundled = !own && spec.requires ? bundledCodex(spec.requires[0]) : undefined
  return {
    command: spec.command,
    args: spec.args,
    // What codex.js would have set for it, so Codex behaves the same.
    env: bundled
      ? { CODEX_PATH: bundled.exe, CODEX_MANAGED_PACKAGE_ROOT: bundled.root, CODEX_MANAGED_BY_NPM: '1' }
      : { CODEX_PATH: own || undefined }
  }
}

/**
 * OpenAI Codex CLI, through the ACP adapter (@agentclientprotocol/codex-acp).
 * The adapter uses the login Codex already has (`codex login`).
 */
export default acpPlugin({
  id: 'codex',
  sessionLog: 'codex',
  name: 'Codex',
  description: tk('OpenAI 的 Codex 命令行，经 ACP 适配器接入'),
  settings: [
    { key: 'CODEX_CLI_PATH', label: tk('Codex CLI 路径'), placeholder: 'codex',
      help: tk('可填写实际可执行文件的绝对路径。桌面应用无法执行 shell 别名；留空则从 PATH 查找。') },
    { key: 'CODEX_ACP_PATH', label: tk('Codex ACP 适配器路径'), placeholder: 'codex-acp',
      help: tk('填写 codex-acp 可执行文件的路径；留空则从 PATH 查找。') }
  ],
  login: (config) => ({ command: config.CODEX_CLI_PATH?.trim() || 'codex', args: ['login'] }),
  account: (config) => codexAccount(config),
  upgrade: {
    run: { command: 'npm', args: ['install', '-g', '@openai/codex@latest', '@agentclientprotocol/codex-acp@latest'] },
    // Compared with the adapter that runs (see launchedVersions), not with a global codex the app never starts.
    latest: { command: 'npm', args: ['view', '@agentclientprotocol/codex-acp', 'version'] }
  },
  quirks: {
    inputIncludesCache: true,
    // Its first session in a process loads the user's Codex config, plugins and MCP servers (seconds); later ones are quick.
    warmSession: true,
    authHint: tk('请在 设置 → Agent 后端 → Codex 里点「登录」（会在终端里运行 codex login），登录后重试。'),
    missingHint: tk('请在 设置 → Agent 后端 → Codex 里点「安装」，或在终端运行 npm install -g @openai/codex @agentclientprotocol/codex-acp，然后重试。')
  },
  launch: ({ config }) => codexLaunch(config)
})
