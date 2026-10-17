import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acpPlugin } from '../acp'
import { findOnPath } from '../install'
import { tk } from '../../../shared/i18n'

/**
 * Google Antigravity's own ACP server (the ACP registry's `antigravity-acp`). The `agy`
 * command line has no ACP mode; Google ships this server for editors instead. It signs in
 * on its own (Google account or a Gemini API key) and keeps its state in ~/.gemini/antigravity-acp.
 */
const VERSION = '1.4.0'
const EXE = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
/** Where the app's 「安装」 puts it. */
export const AGY_HOME = join(homedir(), '.agy-acp-server')

const ARCHIVES: Record<string, string> = {
  'win32-x64': `windows/agy-acp-server-${VERSION}-windows-x86_64.zip`,
  'win32-arm64': `windows/agy-acp-server-${VERSION}-windows-arm64.zip`,
  'darwin-arm64': `macos/agy-acp-server-${VERSION}-darwin-arm64.zip`,
  'darwin-x64': `macos/agy-acp-server-${VERSION}-darwin-x86_64.zip`,
  'linux-x64': `linux/agy-acp-server-${VERSION}-linux-x86_64.zip`,
  'linux-arm64': `linux/agy-acp-server-${VERSION}-linux-arm64.zip`
}
const archive = ARCHIVES[`${process.platform}-${process.arch}`]

/** The server: the path set in settings, AGY_ACP_BIN, the app's own install, or one on PATH. */
export function findAgy(config: Record<string, string> = {}, env = process.env): string | undefined {
  for (const p of [config.AGY_ACP_BIN, env.AGY_ACP_BIN, join(AGY_HOME, EXE)]) if (p && existsSync(p)) return p
  return findOnPath(EXE, env) ?? findOnPath('agy_acp_server', env)
}

const MISSING = tk('找不到 Antigravity 的 ACP 服务（agy_acp_server）。请在 设置 → Agent 后端 → Antigravity 里点「安装」，或填写它的路径，然后重试。')

export default acpPlugin({
  id: 'antigravity',
  name: 'Antigravity',
  description: tk('Google Antigravity（agy）官方 ACP 服务'),
  signIn: true,
  settings: [
    {
      key: 'GEMINI_API_KEY',
      label: 'Gemini API Key',
      secret: true,
      placeholder: 'AI…',
      help: tk('在 aistudio.google.com 生成。留空则点上方「登录」，用 Google 账号登录。')
    },
    { key: 'model', label: tk('默认模型'), placeholder: 'gemini-3.8-flash' },
    { key: 'AGY_ACP_BIN', label: tk('服务程序路径'), placeholder: EXE, help: tk('留空自动查找；也可填写 agy_acp_server 的绝对路径。') }
  ],
  isInstalled: (config) => !!findAgy(config),
  quirks: { missingHint: MISSING },
  // Built-in curl and tar (Windows 10 and later have both): download Google's archive, unpack it into ~/.agy-acp-server.
  upgrade: archive
    ? {
        run: { command: 'curl', args: ['-fL', '--create-dirs', '-o', join(AGY_HOME, 'agy-acp-server.zip'), `https://dl.google.com/agy-extensions/releases/${archive}`] },
        after: { label: tk('解压 Antigravity 服务'), command: 'tar', args: ['-xf', join(AGY_HOME, 'agy-acp-server.zip'), '-C', AGY_HOME] }
      }
    : undefined,
  launch: ({ config }) => ({
    command: findAgy(config) ?? EXE,
    // The registry's Linux entry passes an empty --uid.
    args: process.platform === 'linux' ? ['--uid='] : [],
    env: {
      GEMINI_API_KEY: config.GEMINI_API_KEY || undefined,
      // A new session always opens on the default model: make that the chosen one (saves a model switch).
      AGY_ACP_DEFAULT_MODEL: config.model || undefined
    }
  })
})
