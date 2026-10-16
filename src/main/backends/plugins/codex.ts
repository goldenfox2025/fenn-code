import { acpPlugin, type AccountCheck } from '../acp'
import { t, tk } from '../../../shared/i18n'

/** `codex login status` says "Logged in using ChatGPT" (exit 0) or "Not logged in" (exit 1). */
export function codexAccount(): AccountCheck {
  return {
    command: 'codex',
    args: ['login', 'status'],
    requires: ['codex-acp'],
    stderr: true,
    parse: (out) => {
      const line = out.split(/\r?\n/).find((l) => /logged in/i.test(l))?.trim() ?? ''
      if (/not logged in/i.test(line)) return { installed: true, signedIn: false }
      const via = /using (.+)$/i.exec(line)?.[1]
      return { installed: true, signedIn: line ? true : undefined, detail: via ? (/chatgpt/i.test(via) ? t('ChatGPT 账号') : via) : undefined }
    }
  }
}

/**
 * OpenAI Codex CLI, through the ACP adapter (@agentclientprotocol/codex-acp).
 * The adapter uses the login Codex already has (`codex login`).
 */
export default acpPlugin({
  id: 'codex',
  name: 'Codex',
  description: tk('OpenAI 的 Codex 命令行，经 ACP 适配器接入'),
  login: { command: 'codex', args: ['login'] },
  account: () => codexAccount(),
  upgrade: {
    run: { command: 'npm', args: ['install', '-g', '@openai/codex@latest', '@agentclientprotocol/codex-acp@latest'] },
    latest: { command: 'npm', args: ['view', '@openai/codex', 'version'] }
  },
  quirks: {
    authHint: tk('请在 设置 → Agent 后端 → Codex 里点「登录」（会在终端里运行 codex login），登录后重试。'),
    missingHint: tk('请在 设置 → Agent 后端 → Codex 里点「安装」，或在终端运行 npm install -g @openai/codex @agentclientprotocol/codex-acp，然后重试。')
  },
  launch: () => ({ command: 'codex-acp', args: [] })
})
