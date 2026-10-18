import { acpPlugin, type AccountCheck } from '../acp'
import { finishNpmInstall } from '../npmSetup'
import { t, tk } from '../../../shared/i18n'

/** `claude auth status` prints {"loggedIn": true|false, "authMethod": "…", …}. */
export function claudeAccount(): AccountCheck {
  return {
    command: 'claude',
    args: ['auth', 'status'],
    requires: ['claude-agent-acp'],
    parse: (out) => {
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>
      const signedIn = typeof j.loggedIn === 'boolean' ? j.loggedIn : undefined
      const how: Record<string, string> = { claude_ai: t('Claude 账号'), 'claude.ai': t('Claude 账号'), oauth_token: t('Claude 账号'), api_key: 'API Key' }
      const method = typeof j.authMethod === 'string' ? (how[j.authMethod] ?? j.authMethod) : ''
      const plan = typeof j.subscriptionType === 'string' ? j.subscriptionType : typeof j.subscription === 'string' ? j.subscription : ''
      return { installed: true, signedIn, detail: [method, plan].filter(Boolean).join(' · ') || undefined }
    }
  }
}

/**
 * Claude Code, through the ACP adapter (@agentclientprotocol/claude-agent-acp).
 * The adapter uses the login Claude Code already has (`claude auth login`).
 */
export default acpPlugin({
  id: 'claude-code',
  sessionLog: 'claude',
  slowStart: true,
  name: 'Claude Code',
  description: tk('Anthropic 的 Claude Code，经 ACP 适配器接入'),
  login: { command: 'claude', args: ['auth', 'login'] },
  account: () => claudeAccount(),
  upgrade: {
    run: { command: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code@latest', '@agentclientprotocol/claude-agent-acp@latest'] },
    latest: { command: 'npm', args: ['view', '@anthropic-ai/claude-code', 'version'] },
    after: finishNpmInstall('claude', '@anthropic-ai/claude-code', 'install.cjs')
  },
  quirks: {
    authHint: tk('请在 设置 → Agent 后端 → Claude Code 里点「登录」（会在终端里运行 claude auth login），登录后重试。'),
    missingHint:
      tk('请在 设置 → Agent 后端 → Claude Code 里点「安装」，或在终端运行 npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp，然后重试。')
  },
  launch: () => ({ command: 'claude-agent-acp', args: [] })
})
