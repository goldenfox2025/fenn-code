import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { acpPlugin } from '../acp'
import { findOnPath } from '../install'
import { finishNpmInstall } from '../npmSetup'
import { t, tk } from '../../../shared/i18n'

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Where the Grok program is: the copy Grok's own installer keeps in
 * ~/.grok/bin, or a `grok` on PATH. Ancora never downloads it by itself; when
 * neither exists Grok shows as not installed, and Settings offers to install it.
 */
export function findGrok(env = process.env): string | undefined {
  let grokHome = env.GROK_HOME
  if (!grokHome) {
    try {
      grokHome = join(realpathSync(homedir()), '.grok')
    } catch {
      grokHome = join(homedir(), '.grok')
    }
  }
  const own = join(grokHome, 'bin', `grok${EXE}`)
  if (existsSync(own)) return own
  return findOnPath('grok', env)
}

const MISSING = tk('找不到 Grok 程序。请在 设置 → Agent 后端 → Grok 里点「安装」，或在终端运行 npm install -g @xai-official/grok，然后重试。')

/** xAI Grok Build CLI, which speaks ACP natively over stdio. */
export default acpPlugin({
  id: 'grok',
  sessionLog: 'grok',
  name: 'Grok',
  description: tk('xAI 官方 Grok Build 命令行'),
  signIn: true,
  settings: [
    {
      key: 'XAI_API_KEY',
      label: 'xAI API Key',
      secret: true,
      placeholder: 'xai-…',
      help: tk('在 console.x.ai 生成。留空则点上方「登录」，用 grok.com 账号登录。')
    },
    { key: 'model', label: tk('默认模型'), placeholder: 'grok-4.6' }
  ],
  quirks: {
    inputIncludesCache: true,
    // Its updates carry how full the context is (no ACP usage_update); /session-info shows the same figure.
    contextTokensMeta: 'totalTokens',
    // Its /context draws a panel in Grok's own terminal and sends nothing over ACP.
    commandAliases: { context: 'session-info' },
    // Grok appends `_meta.rules` on session/new to its system prompt (its ACP docs, "Session _meta options").
    systemPromptMeta: 'rules',
    // Grok has no ACP mode; it skips permission prompts through its own command (`input: on|off`).
    // The names are Claude Code's, so the menu shows them the same way (每次询问 / 全部允许).
    commandOption: {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      initial: 'default',
      choices: [
        { value: 'default', name: 'Default', command: '/always-approve off' },
        { value: 'bypassPermissions', name: 'Bypass permissions', command: '/always-approve on' }
      ]
    },
    authHint: tk('请在 设置 → Agent 后端 → Grok 填写 xAI API Key，或点「登录」用 grok.com 账号登录。'),
    missingHint: MISSING,
    // Grok reports retries through its own `_x.ai/session_notification`; surface them as notices.
    translateExt(method, params) {
      if (!/^_?x\.ai\/session_notification$/.test(method)) return null
      const p = params as { sessionId?: string; update?: { sessionUpdate?: string; attempt?: number; max_retries?: number; reason?: string } }
      const u = p.update
      if (!p.sessionId || u?.sessionUpdate !== 'retry_state') return null
      return {
        sessionId: p.sessionId,
        event: {
          kind: 'notice',
          level: 'warning',
          key: 'grok-retry',
          text: t('连接 Grok 失败，正在重试（{0}/{1}）：{2}', u.attempt, u.max_retries, (u.reason ?? '').slice(0, 160))
        }
      }
    }
  },
  // `grok --version` tells whether it's installed; signing in is checked when a session starts.
  account: () => ({
    command: findGrok() ?? 'grok',
    args: ['--version'],
    parse: (out) => {
      const version = /\d+\.\d+\.\d+/.exec(out)?.[0]
      return { installed: true, version, detail: version ? `grok ${version}` : undefined }
    }
  }),
  upgrade: {
    run: { command: 'npm', args: ['install', '-g', '@xai-official/grok@latest'] },
    latest: { command: 'npm', args: ['view', '@xai-official/grok', 'version'] },
    after: finishNpmInstall('grok', '@xai-official/grok', 'bin/postinstall.js')
  },
  launch: (host) => ({
    command: findGrok() ?? 'grok',
    args: ['agent', ...(host.config.model ? ['--model', host.config.model] : []), 'stdio'],
    env: { XAI_API_KEY: host.config.XAI_API_KEY }
  })
})
