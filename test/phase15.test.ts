import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import { makeCore } from './helpers'

describe('one-time routines', () => {
  it('still run at their time after 「立即运行」, then switch off', async () => {
    const { core, store, dispose } = await makeCore()
    const at = Date.now() + 10 * 60_000
    const r = await core.saveRoutine({ name: '一次', prompt: '你好', schedule: { kind: 'once', at }, target: {}, enabled: true })
    await core.scheduler.run(r.id)
    let after = store.routines[0]
    expect(after.enabled).toBe(true)
    expect(after.nextRunAt).toBe(at)
    // Editing it keeps the scheduled run too.
    await core.saveRoutine({ ...after, name: '一次（改）' })
    expect(store.routines[0].nextRunAt).toBe(at)
    await core.scheduler.tick(at + 1)
    after = store.routines[0]
    expect(after.enabled).toBe(false)
    expect(after.nextRunAt).toBeUndefined()
    await dispose()
  }, 30000)
})

describe('routine chats', () => {
  it('are not sent to the agent for project auto-assignment', async () => {
    const { core, store, dispose } = await makeCore()
    await core.createProject({ name: '装修', description: '瓷砖、预算、设计师' })
    const prompts: string[] = []
    const mgr = (core as unknown as { backends: BackendManager }).backends
    const orig = mgr.prompt.bind(mgr)
    mgr.prompt = (b, s, parts) => {
      prompts.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      return orig(b, s, parts)
    }
    const r = await core.saveRoutine({ name: '瓷砖', prompt: '瓷砖 选哪种颜色比较耐脏', schedule: { kind: 'interval', minutes: 60 }, target: {}, enabled: true })
    await core.scheduler.run(r.id)
    const conv = store.conversations.find((c) => c.routineId === r.id)!
    expect(conv.projectId).toBeUndefined()
    await new Promise((res) => setTimeout(res, 1500))
    expect(prompts.some((p) => p.includes('<<classify>>'))).toBe(false)
    expect(store.conversation(conv.id)!.projectId).toBeUndefined()
    await dispose()
  }, 30000)
})

describe('restarting a backend mid-reply', () => {
  it('says why in Chinese instead of the raw exit signal', async () => {
    const agent = join(__dirname, '../resources/mock-agent.mjs')
    const file = join(mkdtempSync(join(tmpdir(), 'oc-restart-')), 'backends.json')
    const decl = (extra: Record<string, unknown> = {}) => [{ id: 'q', name: 'Q', command: process.execPath, args: [agent], ...extra }]
    writeFileSync(file, JSON.stringify(decl()))
    const mgr = new BackendManager({
      plugins: loadPlugins(file),
      settings: { get: () => ({}), set: () => {} },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: () => {}
    })
    const s = await mgr.newSession('q')
    const turn = mgr.prompt('q', s.sessionId, [{ type: 'text', text: '帮我写个笔记' }])
    await new Promise((res) => setTimeout(res, 100))
    writeFileSync(file, JSON.stringify(decl({ env: { X: '1' } })))
    await mgr.setPlugins(loadPlugins(file))
    const r = await turn
    expect(r.stopReason).toBe('error')
    expect(r.error).toBe('Q 的配置已更改，已重新启动。请点「重试」。')
    await mgr.disposeAll()
  }, 30000)
})
