import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import type { HostEvent } from '../src/shared/contract'

function makeManager(events: HostEvent[]) {
  const store: Record<string, Record<string, string>> = {}
  const mgr: BackendManager = new BackendManager({
    plugins: loadPlugins(),
    settings: {
      get: (id) => store[id] ?? {},
      set: (id, k, v) => ((store[id] ??= {})[k] = v)
    },
    resourcesDir: join(__dirname, '../resources'),
    nodeCommand: { command: process.execPath, env: {} },
    defaultCwd: process.cwd(),
    emit: (e) => {
      events.push(e)
      if (e.type === 'permission') mgr.respondPermission(e.request.requestId, 'allow')
    }
  })
  return mgr
}

describe('backend contract over ACP', () => {
  it('discovers plugins from the plugins folder', () => {
    const ids = loadPlugins().map((p) => p.id)
    expect(ids).toContain('grok')
    expect(ids).toContain('mock')
  })

  it('streams a turn from the mock ACP agent', async () => {
    const events: HostEvent[] = []
    const mgr = makeManager(events)
    const s = await mgr.newSession('mock')
    expect(s.models?.map((m) => m.id)).toEqual(['mock-fast', 'mock-smart'])
    await mgr.setModel('mock', s.sessionId, 'mock-smart')
    const res = await mgr.prompt('mock', s.sessionId, [{ type: 'text', text: '帮我写个笔记' }])
    expect(res.stopReason).toBe('end_turn')
    const kinds = new Set(events.flatMap((e) => (e.type === 'agent' ? [e.event.kind] : [e.type])))
    expect(kinds).toEqual(new Set(['thought.delta', 'plan', 'tool.start', 'tool.update', 'message.delta', 'permission', 'backend-log', 'usage', 'options', 'commands']))
    const text = events.map((e) => (e.type === 'agent' && e.event.kind === 'message.delta' ? e.event.text : '')).join('')
    expect(text).toContain('已获得许可')
    expect(text).toContain('mock-smart')
    await mgr.disposeAll()
  })

  it('cancels a running turn', async () => {
    const mgr = makeManager([])
    const s = await mgr.newSession('mock')
    const p = mgr.prompt('mock', s.sessionId, [{ type: 'text', text: 'hi' }])
    setTimeout(() => mgr.cancel('mock', s.sessionId), 400)
    expect((await p).stopReason).toBe('cancelled')
    await mgr.disposeAll()
  })
})

describe('slow agent start', () => {
  it('tells the user the agent is starting, then clears the note', async () => {
    const { makeCore, until } = await import('./helpers')
    const { core, store, events, dispose } = await makeCore(undefined, { MOCK_SLOW_START: '6000' })
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await until(
      () =>
        events.some(
          (e) => e.type === 'message' && e.message.conversationId === c.id && e.message.blocks.some((b) => b.type === 'notice' && b.key === 'starting')
        ),
      10000
    )
    await until(() => store.conversation(c.id)!.status === 'idle' && store.messagesOf(c.id).length >= 2, 15000)
    const reply = store.messagesOf(c.id).find((m) => m.role === 'assistant')!
    expect(reply.blocks.some((b) => b.type === 'notice')).toBe(false)
    expect(reply.state).toBe('done')
    await dispose()
  }, 30000)
})

describe('reloading backends.json', () => {
  it('swaps the plugin list and restarts running backends', async () => {
    const events: HostEvent[] = []
    const mgr = makeManager(events)
    await mgr.newSession('mock')
    const lost: string[] = []
    mgr.onSessionsLost((id) => lost.push(id))
    await mgr.setPlugins(loadPlugins().filter((p) => p.id !== 'mock'))
    expect(lost).toEqual(['mock'])
    expect(mgr.has('mock')).toBe(false)
    expect(mgr.list().some((b) => b.id === 'grok')).toBe(true)
    await mgr.setPlugins(loadPlugins())
    const s = await mgr.newSession('mock')
    expect(s.sessionId).toBeTruthy()
    await mgr.disposeAll()
  }, 20000)
})

describe('a broken backends.json', () => {
  it('says exactly where it is wrong and keeps the last good backends', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { makeCore } = await import('./helpers')
    const file = join(mkdtempSync(join(tmpdir(), 'oc-cfg-')), 'backends.json')
    writeFileSync(file, JSON.stringify([{ id: 'extra', name: 'Extra', command: 'extra-cli' }]))
    const { core, dispose } = await makeCore()
    core.reloadPlugins = () => loadPlugins(file)
    expect((await core.reloadBackends()).backends.some((b) => b.id === 'extra')).toBe(true)

    writeFileSync(file, '[\n  { "id": "extra", "name": "Extra", "command": "extra-cli" },\n]\n')
    const r = await core.reloadBackends()
    expect(r.error).toMatch(/第 3 行/)
    expect(r.backends.some((b) => b.id === 'extra')).toBe(true) // still there
    expect(core.backendsConfigStatus().error).toBe(r.error)

    writeFileSync(file, JSON.stringify([{ id: 'extra', name: 'Extra' }]))
    expect((await core.reloadBackends()).error).toContain('缺少 "command"')

    writeFileSync(file, JSON.stringify([{ id: 'extra', name: 'Extra', command: 'x', settings: [{ key: 'EXTRA_KEY', secret: true }] }]))
    const ok = await core.reloadBackends()
    expect(ok.error).toBeUndefined()
    expect(ok.backends.find((b) => b.id === 'extra')!.settings[0]).toMatchObject({ key: 'EXTRA_KEY', label: 'EXTRA_KEY', secret: true })
    await dispose()
  }, 20000)

  it('explains a missing program instead of a bare ENOENT', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const file = join(mkdtempSync(join(tmpdir(), 'oc-cfg-')), 'backends.json')
    writeFileSync(file, JSON.stringify([{ id: 'ghost', name: 'Ghost', command: 'definitely-not-installed-cli' }]))
    const events: HostEvent[] = []
    const mgr = makeManager(events)
    await mgr.setPlugins(loadPlugins(file))
    await expect(mgr.newSession('ghost')).rejects.toThrow(/找不到 Ghost 的程序「definitely-not-installed-cli」.*安装/)
    await expect(mgr.newSession('gone')).rejects.toThrow(/已经不存在了/)
    await mgr.disposeAll()
  }, 20000)
})

describe('stray replies from the agent', () => {
  it('drops replies to requests Ancora never sent (Grok\'s "skills-reload"), keeps everything else', async () => {
    const { dropStrayResponses } = await import('../src/main/backends/acp/AcpBackend')
    const input = [
      { jsonrpc: '2.0', id: 'skills-reload', result: {} },
      { jsonrpc: '2.0', id: 3, result: { ok: true } },
      { jsonrpc: '2.0', id: 'x1', method: 'session/request_permission', params: {} },
      { jsonrpc: '2.0', method: 'session/update', params: {} }
    ]
    const out: unknown[] = []
    await new ReadableStream({ start(c) { input.forEach((m) => c.enqueue(m)); c.close() } })
      .pipeThrough(dropStrayResponses())
      .pipeTo(new WritableStream({ write(m) { out.push(m) } }))
    expect(out).toEqual(input.slice(1))
  })
})
