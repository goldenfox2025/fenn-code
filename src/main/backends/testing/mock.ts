import { join } from 'node:path'
import { acpPlugin } from '../acp'
import { tk } from '../../../shared/i18n'

/** A local ACP agent with canned behaviour, for automated tests and screenshots only. */
export default /* @__PURE__ */ acpPlugin({
  id: 'mock',
  testOnly: true,
  name: tk('演示 Agent'),
  description: tk('本地演示用 agent，无需账号'),
  launch: ({ nodeCommand, resourcesDir }) => ({
    command: nodeCommand.command,
    args: [join(resourcesDir, 'mock-agent.mjs')],
    env: nodeCommand.env
  })
})
