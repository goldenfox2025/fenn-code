// Manual check against the real Grok CLI: FENN_GROK=1 npx vitest run test/grok.manual.test.ts
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'

describe.runIf(process.env.FENN_GROK)('grok (manual)', () => {
  it('creates a session and runs a turn', async () => {
    const text: string[] = []
    const mgr = new BackendManager({
      plugins: loadPlugins(),
      settings: { get: () => ({ XAI_API_KEY: process.env.XAI_API_KEY ?? '' }), set: () => {} },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: () => {}
    })
    const notices: string[] = []
    mgr.onAgentEvent((_b, _s, e) => {
      if (e.kind === 'message.delta') text.push(e.text)
      if (e.kind === 'notice') notices.push(e.text)
    })
    const s = await mgr.newSession('grok')
    console.log('models', s.models?.map((m) => m.id), s.currentModelId)
    const turn = mgr.prompt('grok', s.sessionId, [{ type: 'text', text: 'Say "pong" and nothing else.' }])
    // With a bad key Grok retries for a long time; stop once we see it surfaced.
    const timer = setInterval(() => notices.length && mgr.cancel('grok', s.sessionId), 500)
    const r = await turn
    clearInterval(timer)
    console.log('result', r, text.join(''), notices.slice(-1))
    expect(s.sessionId).toBeTruthy()
    await mgr.disposeAll()
  }, 180000)
})
