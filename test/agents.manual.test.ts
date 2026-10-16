// Manual check against the real Claude Code and Codex adapters, kept as small as possible
// (one handshake and, when signed in, one tiny prompt each):
//   ANCORA_AGENTS=claude-code,codex npx vitest run test/agents.manual.test.ts
// Needs claude + claude-agent-acp and codex + codex-acp on PATH (the 安装 button installs them).
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import type { AgentEvent } from '../src/shared/contract'

const ids = (process.env.ANCORA_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

describe.runIf(ids.length)('Claude Code and Codex (manual)', () => {
  it.each(ids)('%s: detects, connects and answers one tiny prompt', async (id) => {
    const events: AgentEvent[] = []
    const mgr = new BackendManager({
      plugins: loadPlugins(),
      settings: { get: () => ({}), set: () => {} },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: (e) => {
        if (e.type === 'agent') events.push(e.event)
        // Nothing here should need a tool; refuse anything that asks.
        if (e.type === 'permission') mgr.respondPermission(e.request.requestId, e.request.options.find((o) => o.kind.startsWith('reject'))?.id ?? e.request.options[0].id)
      }
    })
    try {
      const account = await mgr.account(id)
      console.log(id, 'account', account)
      expect(account.installed, `${id} is not installed`).not.toBe(false)
      if (account.signedIn === false) {
        await expect(mgr.newSession(id)).rejects.toThrow('登录')
        console.log(id, 'not signed in: handshake ok, stopped before any prompt')
        return
      }
      const s = await mgr.newSession(id)
      console.log(id, 'models', s.models?.map((m) => m.id).join(', '), '| options', s.options?.map((o) => `${o.id}=${o.current}`).join(', '))
      console.log(id, 'images', mgr.acceptsImages(id))
      const stop = await mgr.prompt(id, s.sessionId, [{ type: 'text', text: 'Reply with exactly: ok' }])
      const text = events.filter((e) => e.kind === 'message.delta').map((e) => (e as { text: string }).text).join('')
      console.log(id, 'stop', stop, 'reply', JSON.stringify(text))
      expect(stop.stopReason, stop.error).toBe('end_turn')
      expect(text.trim().replace(/[.!。]$/, '').toLowerCase()).toBe('ok')
    } finally {
      await mgr.disposeAll()
    }
  }, 180_000)
})
