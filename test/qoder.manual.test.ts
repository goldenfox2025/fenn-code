// Manual check against the real Qoder CLI (qodercli on PATH): ANCORA_QODER=1 npx vitest run test/qoder.manual.test.ts
// Not signed in: checks the handshake, the status command and the sign-in message.
// Signed in (qodercli login, or QODER_PERSONAL_ACCESS_TOKEN set): also runs a real turn with
// a file read, a terminal command and a mode switch, and prints what Qoder offered.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import type { AgentEvent } from '../src/shared/contract'

describe.runIf(process.env.ANCORA_QODER)('qoder (manual)', () => {
  it('signs in, offers models and modes, and runs a turn with tools', async () => {
    const events: AgentEvent[] = []
    const permissions: string[] = []
    let mgr!: BackendManager
    mgr = new BackendManager({
      plugins: loadPlugins(),
      settings: { get: () => ({ QODER_PERSONAL_ACCESS_TOKEN: process.env.QODER_PERSONAL_ACCESS_TOKEN ?? '' }), set: () => {} },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: (e) => {
        if (e.type === 'agent') events.push(e.event)
        if (e.type === 'permission') {
          permissions.push(e.request.title)
          const allow = e.request.options.find((o) => o.kind === 'allow_once') ?? e.request.options[0]
          mgr.respondPermission(e.request.requestId, allow.id)
        }
      }
    })
    const account = await mgr.account('qoder')
    console.log('account', account)
    expect(account.detail).toMatch(/qodercli \d/)
    const methods = await mgr.authMethods('qoder')
    console.log('auth methods', methods)
    expect(methods.length).toBeGreaterThan(0)

    if (!account.signedIn) {
      await expect(mgr.newSession('qoder')).rejects.toThrow('Qoder 需要登录。请在 设置 → Agent 后端 → Qoder 里点「登录」，或填写「Access Token」，然后重试。')
      await mgr.disposeAll()
      return
    }

    const folder = mkdtempSync(join(tmpdir(), 'oc-qoder-'))
    writeFileSync(join(folder, 'secret.txt'), 'the answer is 4217\n')
    const s = await mgr.newSession('qoder', { cwd: folder, folder })
    console.log('models', s.models?.map((m) => `${m.id} (${m.name})`), 'current', s.currentModelId)
    console.log('options', JSON.stringify(s.options, null, 1))
    expect(s.models?.length).toBeGreaterThan(0)
    const mode = s.options?.find((o) => o.category === 'mode')
    expect(mode, 'Qoder should offer a permission mode').toBeTruthy()

    const r1 = await mgr.prompt('qoder', s.sessionId, [
      { type: 'text', text: 'Read secret.txt in the current folder, then run `echo hello-from-terminal` in a terminal. Reply with the number from the file and the command output, nothing else.' }
    ])
    const text = events.filter((e) => e.kind === 'message.delta').map((e) => (e as { text: string }).text).join('')
    const tools = events.filter((e) => e.kind === 'tool.start').map((e) => (e as { title: string }).title)
    console.log('stop', r1, '\nreply', text, '\ntools', tools, '\npermissions asked', permissions)
    expect(r1.stopReason).toBe('end_turn')
    expect(text).toContain('4217')

    if (mode) {
      const other = mode.choices.find((c) => c.value !== mode.current)!
      const after = await mgr.setOption('qoder', s.sessionId, mode.id, other.value)
      console.log('mode now', after?.find((o) => o.id === mode.id)?.current)
      expect(after?.find((o) => o.id === mode.id)?.current).toBe(other.value)
    }
    if (s.models && s.models.length > 1) {
      const other = s.models.find((m) => m.id !== s.currentModelId)!
      await mgr.setModel('qoder', s.sessionId, other.id)
      console.log('model switched to', other.id)
    }
    await mgr.disposeAll()
  }, 300000)
})
