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

describe('a permission mode the agent takes only as a command (Grok)', () => {
  it('shows as the mode option, sends its command quietly, and follows the command typed by hand', async () => {
    const { acpPlugin } = await import('../src/main/backends/acp')
    const plugin = acpPlugin({
      id: 'cmd-mode',
      name: 'Cmd',
      launch: ({ nodeCommand, resourcesDir }) => ({ command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, MOCK_NO_MODE: '1' } }),
      quirks: {
        commandOption: {
          id: 'mode', name: 'Mode', category: 'mode', initial: 'default',
          choices: [
            { value: 'default', name: 'Default', command: '/always-approve off' },
            { value: 'bypassPermissions', name: 'Bypass permissions', command: '/always-approve on' }
          ]
        }
      }
    })
    const events: HostEvent[] = []
    const mgr = new BackendManager({
      plugins: [plugin],
      settings: { get: () => ({}), set: () => undefined },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: (e) => events.push(e)
    })
    try {
      const s = await mgr.newSession('cmd-mode')
      expect(s.options?.find((o) => o.id === 'mode')).toMatchObject({ category: 'mode', current: 'default' })
      const options = await mgr.setOption('cmd-mode', s.sessionId, 'mode', 'bypassPermissions')
      expect(options?.find((o) => o.id === 'mode')?.current).toBe('bypassPermissions')
      // What the agent said back to the command is not part of any reply.
      const said = () => events.map((e) => (e.type === 'agent' && e.event.kind === 'message.delta' ? e.event.text : '')).join('')
      expect(said()).toBe('')
      await mgr.prompt('cmd-mode', s.sessionId, [{ type: 'text', text: '当前权限' }])
      expect(said()).toBe('全部自动批准')
      await mgr.prompt('cmd-mode', s.sessionId, [{ type: 'text', text: '/always-approve' }])
      const last = events.filter((e) => e.type === 'agent' && e.event.kind === 'options').at(-1)
      expect(last?.type === 'agent' && last.event.kind === 'options' && last.event.options.find((o) => o.id === 'mode')?.current).toBe('default')
    } finally { await mgr.disposeAll() }
  }, 30000)
})

describe('an agent that signs in again in each process and takes rules in its own _meta (Antigravity)', () => {
  it('signs in quietly when a session needs it, and hands the rules over where it advertises', async () => {
    const { acpPlugin } = await import('../src/main/backends/acp')
    const plugin = acpPlugin({
      id: 'meta-auth',
      name: 'MetaAuth',
      launch: ({ nodeCommand, resourcesDir }) => ({ command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, MOCK_AUTH: '1', MOCK_META_PROMPT: '1' } }),
      quirks: { systemPromptMeta: 'antigravity.systemPrompt.append', autoAuth: () => 'mock-login' }
    })
    const events: HostEvent[] = []
    const mgr = new BackendManager({
      plugins: [plugin],
      settings: { get: () => ({}), set: () => undefined },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: (e) => events.push(e)
    })
    try {
      const s = await mgr.newSession('meta-auth', { system: '<ancora-context>规则</ancora-context>' })
      expect(s.systemApplied).toBe(true)
      await mgr.prompt('meta-auth', s.sessionId, [{ type: 'text', text: '规则在哪' }])
      const said = events.map((e) => (e.type === 'agent' && e.event.kind === 'message.delta' ? e.event.text : '')).join('')
      expect(said).toBe('系统提示：有；本条消息：无')
    } finally { await mgr.disposeAll() }
  }, 30000)
})

describe('what an agent reports beyond ACP usage (Grok) and what background chores leave behind', () => {
  const managerFor = async (id: string, env: Record<string, string>, quirks: Record<string, unknown> = {}) => {
    const { acpPlugin } = await import('../src/main/backends/acp')
    const plugin = acpPlugin({
      id,
      name: id,
      launch: ({ nodeCommand, resourcesDir }) => ({ command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, ...env } }),
      quirks
    })
    const events: HostEvent[] = []
    const mgr = new BackendManager({
      plugins: [plugin],
      settings: { get: () => ({}), set: () => undefined },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: (e) => events.push(e)
    })
    return { mgr, events }
  }

  it('reads the context from _meta.totalTokens and the window from the model list; /context goes out as /session-info', async () => {
    const { mgr, events } = await managerFor('meta-usage', { MOCK_USAGE: 'meta' }, { contextTokensMeta: 'totalTokens', commandAliases: { context: 'session-info' } })
    try {
      const s = await mgr.newSession('meta-usage')
      await mgr.prompt('meta-usage', s.sessionId, [{ type: 'text', text: '你好' }])
      const usage = events.filter((e) => e.type === 'agent' && e.event.kind === 'usage').map((e) => e.type === 'agent' && e.event)
      expect(usage).toHaveLength(1)
      expect(usage[0]).toMatchObject({ contextUsed: expect.any(Number), contextSize: 500000 })
      const said = () => events.map((e) => (e.type === 'agent' && e.event.kind === 'message.delta' ? e.event.text : '')).join('')
      await mgr.prompt('meta-usage', s.sessionId, [{ type: 'text', text: '/context' }])
      expect(said()).toMatch(/Context: \d+ \/ 500000/)
      // The command's 0 is not an empty context.
      expect(events.filter((e) => e.type === 'agent' && e.event.kind === 'usage')).toHaveLength(1)
    } finally { await mgr.disposeAll() }
  }, 30000)

  it('removes a background chore session from the agent\'s own history', async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const log = join(mkdtempSync(join(tmpdir(), 'ancora-del-')), 'sessions.log')
    const { mgr } = await managerFor('chore', { MOCK_SESSION_LOG: log })
    try {
      await mgr.ask('chore', '你好')
      const s = await mgr.newSession('chore')
      await mgr.prompt('chore', s.sessionId, [{ type: 'text', text: '你好' }])
      await new Promise((r) => setTimeout(r, 300))
      const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
      expect(lines).toHaveLength(1)
      expect(lines[0]).not.toContain(s.sessionId)
    } finally { await mgr.disposeAll() }
  }, 30000)
})
