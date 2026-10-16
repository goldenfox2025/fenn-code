import { acpPlugin, type AccountCheck } from '../acp'
import { tk } from '../../../shared/i18n'
import { qoderCommand } from '../qoderCommand'
import { readQoderCredits } from '../qoderCredits'

/** `qodercli status -o json` prints {"logged_in": true|false, "version": "…"}. */
export function qoderAccount(config: Record<string, string>): AccountCheck {
  return {
    ...qoderCommand(config, ['status', '-o', 'json']),
    env: { QODER_PERSONAL_ACCESS_TOKEN: config.QODER_PERSONAL_ACCESS_TOKEN || undefined },
    parse: (out) => {
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')
      // 1.1.72 reports username/email; older builds may say account/user.
      const who = str(j.email) || str(j.username) || str(j.account) || str(j.user)
      const signedIn = typeof j.logged_in === 'boolean' ? j.logged_in : undefined
      const why = signedIn === false ? str(j.auth_error_message) : ''
      return {
        installed: true,
        version: str(j.version) || undefined,
        signedIn,
        detail: [who, why, j.version ? `qodercli ${j.version}` : ''].filter(Boolean).join(' · ') || undefined
      }
    }
  }
}


/**
 * Qoder CLI, which speaks ACP with `--acp`. It signs in either with
 * `qodercli login` (opened in a terminal from settings) or with a personal
 * access token passed as QODER_PERSONAL_ACCESS_TOKEN.
 */
const plugin = acpPlugin({
  id: 'qoder',
  name: 'Qoder',
  description: tk('Qoder 命令行（qodercli）'),
  login: (config) => qoderCommand(config, ['login']),
  settings: [
    { key: 'QODER_CLI_PATH', label: tk('Qoder CLI 路径'), placeholder: 'qodercli',
      help: tk('留空自动查找；也可填写 qodercli 可执行文件或 qodercli.js 入口的绝对路径。') },
    { key: 'QODER_NODE_PATH', label: tk('Node 路径（用于 Qoder JS 入口）'), placeholder: 'node',
      help: tk('使用 JS 入口时可指定 Node 可执行文件；留空优先使用 Qoder 启动器同目录的 Node，再从 PATH 查找。') },
    {
      key: 'QODER_PERSONAL_ACCESS_TOKEN',
      label: 'Access Token',
      secret: true,
      placeholder: 'pt-…',
      help: tk('在 Qoder 的个人设置里生成。留空则点上方「登录」，在终端里运行 qodercli login。')
    }
  ],
  account: (config) => qoderAccount(config),
  // Qoder CLI is an npm package; npm follows the user's proxy settings.
  upgrade: {
    run: { command: 'npm', args: ['install', '-g', '@qoder-ai/qodercli@latest'] },
    latest: { command: 'npm', args: ['view', '@qoder-ai/qodercli', 'version'] }
  },
  quirks: {
    hideNoneReasoning: true,
    missingHint: tk('请在 设置 → Agent 后端 → Qoder 里点「安装」，或在终端运行 npm install -g @qoder-ai/qodercli，然后重试；如果还是找不到，请完全退出 Ancora 再打开。')
  },
  launch: ({ config }) => ({
    ...qoderCommand(config, ['--acp']),
    env: { QODER_PERSONAL_ACCESS_TOKEN: config.QODER_PERSONAL_ACCESS_TOKEN || undefined }
  })
})

export default { ...plugin, credits: readQoderCredits }
