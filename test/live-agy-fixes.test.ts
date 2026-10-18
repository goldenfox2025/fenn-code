import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'
import type { PermissionRequest } from '../src/shared/contract'
import { ComputerControl, appKeys } from '../src/main/computer/ComputerControl'
import type { AppRef, InputDriver } from '../src/main/computer/drivers'
import { settledTitle } from '../src/renderer/src/toolTitle'
import { inputRead, reportedInput } from '../src/shared/usage'
import { ACCESS_CARD_MS, parseAccessAnswer } from '../src/main/core/AppCore'
import { makeCore, until } from './helpers'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acpPlugin } from '../src/main/backends/acp'
import { workingFolderNote } from '../src/main/backends/plugins/antigravity'
import { optionLabels, permissionText, toolNameOf } from '../src/main/backends/acp/AcpBackend'

const replyText = (store: any, id: string) =>
  store.messagesOf(id).filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.blocks.map((b: any) => b.text ?? '')).join('')

/** Starts a chat whose agent asks before one tool call, as MOCK_ASK_* describes; records the cards the user would see. */
async function ask(env: Record<string, string>) {
  const t = await makeCore(undefined, env)
  const shown: PermissionRequest[] = []
  t.answerWith((r) => (shown.push(r), r.options.find((o) => o.kind === 'reject_once')!.id))
  try {
    const conv = await t.core.startChat({ text: '写一个文件', backendId: 'mock' })
    await until(() => t.store.conversation(conv.id)?.status === 'idle' && replyText(t.store, conv.id).length > 0)
    return { shown, allowed: replyText(t.store, conv.id).includes('已获得许可'), ownTools: t.core.chat.hooks.ownTools?.(conv.id) ?? [] }
  } finally {
    await t.dispose()
  }
}

describe('Antigravity asking before the app\'s own tools', () => {
  it('allows the app\'s own tools at once, with no card (the app asks itself where the user must decide)', async () => {
    const r = await ask({ MOCK_ASK_TITLE: 'fenn_home_board', MOCK_ASK_EN: '1' })
    expect(r.ownTools).toContain('home_board')
    expect(r.shown).toEqual([])
    expect(r.allowed).toBe(true)
    const prefixed = await ask({ MOCK_ASK_TITLE: 'mcp__fenn__home_board', MOCK_ASK_EN: '1' })
    expect(prefixed.shown).toEqual([])
  }, 40000)

  it('still asks for a tool the app doesn\'t have, and never shows the agent\'s English option names', async () => {
    const r = await ask({ MOCK_ASK_TITLE: 'fenn_format_disk', MOCK_ASK_KIND: 'execute', MOCK_ASK_EN: '1' })
    expect(r.shown).toHaveLength(1)
    expect(r.shown[0].options.map((o) => o.label)).toEqual(['总是允许', '允许', '不允许'])
    expect(r.allowed).toBe(false)
  }, 40000)
})

describe('computer_request_access within an agent\'s tool deadline', () => {
  const NOTEPAD: AppRef = { id: 'notepad', name: '记事本', pid: 10 }
  it('returns "not answered yet" before the deadline, keeps the card, and the next call gets the answer', async () => {
    let reply: (a: Record<string, 'full'> | null) => void = () => {}
    let asked = 0
    const cc = new ComputerControl({
      screen: { displays: () => [{ id: 'd1', name: 'd', bounds: { x: 0, y: 0, width: 100, height: 100 }, primary: true }], capture: async () => ({ data: 'A', width: 100, height: 100 }) },
      input: { name: 'fake', unavailable: async () => undefined, apps: async () => [NOTEPAD] } as unknown as InputDriver,
      clipboard: { read: async () => '', write: () => {} },
      enabled: () => true,
      answerWaitMs: 50,
      askAccess: () => (asked++, new Promise((resolve) => (reply = resolve)))
    })
    const tool = cc.tools({ id: 'c1' } as Conversation).find((x) => x.name === 'computer_request_access')!
    const call = () => tool.run({ apps: ['记事本'] }, { conversationId: 'c1' }) as Promise<string>
    expect(await call()).toContain('还没有回答')
    // Asking again while the card waits shows no second card.
    const again = call()
    await new Promise((r) => setTimeout(r, 10))
    reply({ notepad: 'full' })
    expect(await again).toContain('记事本：完全控制')
    expect(asked).toBe(1)
    // Answered after a call had returned: the grant still holds.
    expect(await call()).toContain('已经被允许')
  })
})

describe('what a reply\'s row and footer say', () => {
  it('drops an agent\'s "Running …" title once the call is over', () => {
    expect(settledTitle('Running view_file', true)).toBe('view_file')
    expect(settledTitle('Running view_file', false)).toBe('Running view_file')
    expect(settledTitle('读取 README.md', true)).toBe('读取 README.md')
  })

  it('leaves out input an agent did not count instead of showing 0', () => {
    expect(reportedInput({ input: 0, output: 1 })).toBeUndefined()
    // All input read from the cache is a real 0.
    expect(reportedInput({ input: 0, output: 1, cachedRead: 900 })).toBe(0)
    expect(reportedInput({ input: 1200, output: 30 })).toBe(1200)
  })

  it('shows input with the cache counted in, not a bare 0 beside 773k of cache reads (PC)', () => {
    expect(inputRead({ input: 0, output: 8478, cachedRead: 773_000 })).toEqual({ total: 773_000, cached: 773_000 })
    expect(inputRead({ input: 1200, output: 30, cachedRead: 800, cachedWrite: 100 })).toEqual({ total: 2100, cached: 800 })
    expect(inputRead({ input: 1200, output: 30 })).toEqual({ total: 1200, cached: 0 })
    expect(inputRead({ input: 0, output: 30 })).toBeUndefined()
  })
})

describe('the computer-access card outlives the early return (PC, RC27: it expired at 3 minutes)', () => {
  const NOTEPAD: AppRef = { id: 'notepad', name: '记事本', pid: 10 }
  const deps = {
    screen: { displays: () => [{ id: 'd1', name: 'd', bounds: { x: 0, y: 0, width: 100, height: 100 }, primary: true }], capture: async () => ({ data: 'A', width: 100, height: 100 }) },
    input: { name: 'fake', unavailable: async () => undefined, apps: async () => [NOTEPAD] } as unknown as InputDriver,
    clipboard: { read: async () => '', write: () => {} },
    answerWaitMs: 50
  }

  it('waits as long as a grant lasts, keeps a late answer for the next request, and goes when the reply is stopped', async () => {
    expect(ACCESS_CARD_MS).toBeGreaterThanOrEqual(30 * 60_000)
    const t = await makeCore(undefined, {}, { computer: deps })
    try {
      await t.core.updateSettings({ computerUse: true })
      t.answerWith(() => undefined) // the user is away
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const tool = t.core.computer!.tools(t.store.conversation(conv.id)!).find((x) => x.name === 'computer_request_access')!
      const call = () => tool.run({ apps: ['记事本'] }, { conversationId: conv.id }) as Promise<string>
      expect(await call()).toContain('还没有回答')
      await new Promise((r) => setTimeout(r, 200))
      const card = t.core.chat.pendingRequests().find((p) => p.conversationId === conv.id)
      expect(card?.request.apps?.[0].name).toBe('记事本')
      // Answered after the call returned (and here, after the turn ended): kept for the next request.
      await t.core.respondPermission(card!.request.requestId, 'allow')
      await new Promise((r) => setTimeout(r, 20))
      expect(await call()).toContain('已经被允许')
      expect(t.core.computer!.isActive(conv.id)).toBe(false) // nothing starts until the agent acts

      // Another card, then the reply is stopped: the card goes with it.
      t.core.computer!.forget(conv.id)
      expect(await call()).toContain('还没有回答')
      await until(() => t.core.chat.pendingRequests().some((p) => p.conversationId === conv.id))
      ;(t.core.chat as any).running.add(conv.id)
      await t.core.cancel(conv.id)
      ;(t.core.chat as any).running.delete(conv.id)
      expect(t.core.chat.pendingRequests().filter((p) => p.conversationId === conv.id)).toEqual([])
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('counts a card nobody answered (the safety cap) as not answered, not declined: the next request asks again', async () => {
    expect(parseAccessAnswer(null)).toBeUndefined()
    expect(parseAccessAnswer('deny')).toBeNull()
    const answers: (Record<string, 'full'> | null | undefined)[] = [undefined, null]
    let asked = 0
    const cc = new ComputerControl({ ...deps, answerWaitMs: 1000, enabled: () => true, askAccess: async () => answers[asked++] })
    const tool = cc.tools({ id: 'c1' } as Conversation).find((x) => x.name === 'computer_request_access')!
    const call = () => tool.run({ apps: ['记事本'] }, { conversationId: 'c1' }) as Promise<string>
    await expect(call()).rejects.toThrow('没有回答')
    await expect(call()).rejects.toThrow('没有允许')
    expect(asked).toBe(2)
    // Declined: not asked again in this turn.
    await expect(call()).rejects.toThrow('没有允许')
    expect(asked).toBe(2)
  })
})

describe('one app by any of its names (PC: 「记事本」 allowed, then Notepad.exe refused)', () => {
  it('covers the localized, English, exe and bundle names, on every system', () => {
    const same = (a: string[], b: string[]) => appKeys(...a).some((k) => appKeys(...b).includes(k))
    expect(same(['记事本'], ['notepad', 'Notepad.exe'])).toBe(true)
    expect(same(['计算器'], ['CalculatorApp', 'Calculator'])).toBe(true)
    expect(same(['Calculator'], ['com.apple.calculator', '计算器'])).toBe(true)
    expect(same(['计算器'], ['gnome-calculator', 'Gnome-calculator'])).toBe(true)
    expect(same(['Google Chrome'], ['chrome.exe'])).toBe(true)
    expect(same(['TextEdit.app'], ['com.apple.TextEdit'])).toBe(true)
    expect(same(['记事本'], ['mspaint', '画图'])).toBe(false)
  })

  it('acts in the app the user allowed under another name, and asks no second card for it', async () => {
    let front: AppRef = { id: 'notepad', name: 'Notepad.exe', pid: 10 }
    let asked = 0
    const input = {
      name: 'fake',
      unavailable: async () => undefined,
      apps: async () => [], // not running when asked for
      open: async () => front,
      frontmost: async () => front,
      appAt: async () => front,
      key: async () => {},
      type: async () => {}
    } as unknown as InputDriver
    const cc = new ComputerControl({
      screen: { displays: () => [{ id: 'd1', name: 'd', bounds: { x: 0, y: 0, width: 100, height: 100 }, primary: true }], capture: async () => ({ data: 'A', width: 100, height: 100 }) },
      input,
      clipboard: { read: async () => '', write: () => {} },
      enabled: () => true,
      askAccess: async () => (asked++, {})
    })
    const tools = cc.tools({ id: 'c1' } as Conversation)
    const run = (name: string, a: Record<string, unknown> = {}) => tools.find((x) => x.name === name)!.run(a, { conversationId: 'c1' }) as Promise<unknown>
    await run('computer_request_access', { apps: ['记事本'] })
    expect(JSON.stringify(await run('computer_open_application', { app: 'Notepad' }))).toContain('已打开')
    await run('computer_key', { text: 'ctrl+s' })
    expect(String(await run('computer_request_access', { apps: ['Notepad.exe', 'Notepad'] }))).toContain('已经被允许')
    expect(asked).toBe(1)
    // Another app is still refused.
    front = { id: 'mspaint', name: '画图', pid: 12 }
    await expect(run('computer_key', { text: 'ctrl+s' })).rejects.toThrow('不在允许的程序里')
  })
})

describe('Antigravity told which folder it works in (PC: it wrote into its skills folder)', () => {
  it('names the chat folder in the prompt it appends, on a new session, the one opened ahead, and a resumed one', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-agy-')), 'sessions.log')
    const plugin = acpPlugin({
      id: 'agy-like',
      testOnly: true,
      name: 'AgyLike',
      quirks: { systemPromptMeta: 'antigravity.systemPrompt.append', workingFolderNote, spareSession: true },
      launch: ({ nodeCommand, resourcesDir }) => ({ command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, MOCK_META_PROMPT: '1', MOCK_SESSION_LOG: log } })
    })
    const sent = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => ({ method: l.slice(0, l.indexOf(' ')), ...JSON.parse(l.slice(l.indexOf(' ') + 1)) }))
    const t = await makeCore(undefined, {}, {}, [plugin])
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'agy-like' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const first = sent().find((x) => x.method === 'new')!
      expect(first.append).toContain(`本对话的工作文件夹是 ${first.cwd} 。`)
      // Opened ahead for the next chat: its own folder, which that chat then has.
      t.core.chat.prepareSpare('agy-like')
      await until(() => sent().filter((x) => x.method === 'new').length >= 2)
      const spare = sent().filter((x) => x.method === 'new')[1]
      expect(spare.cwd).not.toBe(first.cwd)
      expect(spare.append).toContain(spare.cwd)
      // Released and resumed: named again.
      t.core.chat.forgetSession(conv.id)
      await new Promise((r) => setTimeout(r, 300))
      await t.core.send(conv.id, '再来')
      await until(() => sent().some((x) => x.method === 'resume'))
      const resumed = sent().find((x) => x.method === 'resume')!
      expect(resumed.cwd).toBe(first.cwd)
      expect(resumed.append).toContain(`本对话的工作文件夹是 ${first.cwd} 。`)
    } finally {
      await t.dispose()
    }
  }, 40000)
})

describe('cards for the app\'s own tools across agents (QA real-adapter matrix)', () => {
  it('names the tool from each agent\'s real payload, and only the app\'s own tools count as its own', async () => {
    const real = [
      // qodercli 1.1.73 --acp
      { title: 'computer_request_access (fenn)', kind: 'other', _meta: { qoder: { toolName: 'mcp__fenn__computer_request_access' } } },
      { title: 'computer_request_access (fenn MCP Server)' },
      // Claude agent ACP 0.93.0
      { title: 'mcp__fenn__computer_request_access', rawInput: { apps: ['记事本'] }, _meta: { claudeCode: { mcpServer: { name: 'fenn' } } } },
      // codex-acp 2.2.2: the permission request has no title; the earlier call names server and tool.
      { title: 'mcp.fenn.computer_request_access', rawInput: { server: 'fenn', tool: 'computer_request_access', arguments: {} } },
      // Grok 1.0.62
      { title: 'fenn__computer_request_access', rawInput: { tool_name: 'fenn__computer_request_access' } }
    ]
    const spoofs = [{ title: 'fenn_rm' }, { title: 'mcp__other__computer_request_access' }, { title: 'fennx_computer_request_access' }, { title: 'computer_request_access (other)' },
      { title: 'computer_request_access', _meta: { claudeCode: { mcpServer: { name: 'other' } } } }, { title: 'x', rawInput: { server: 'other', tool: 'computer_request_access' } }]
    const t = await makeCore()
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      t.core.chat.hooks.ownTools = () => ['computer_request_access']
      const own = (c: object) => (t.core.chat as any).isOwnTool(conv.id, toolNameOf(c) ?? '')
      for (const c of real) expect(own(c), JSON.stringify(c)).toBe(true)
      for (const c of spoofs) expect(own(c), JSON.stringify(c)).toBe(false)
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('allows a Fenn tool Codex asks about with no title, at once and with no card', async () => {
    const r = await ask({ MOCK_ASK_CODEX: '1' })
    expect(r.shown).toEqual([])
    expect(r.allowed).toBe(true)
    for (const title of ['mcp.fenn.home_board', 'fenn__home_board', 'mcp__fenn__home_board']) expect((await ask({ MOCK_ASK_TITLE: title, MOCK_ASK_EN: '1' })).shown).toEqual([])
  }, 60000)

  it('never shows two buttons that read the same', () => {
    const labels = (o: { optionId: string; name: string; kind: string }[]) => optionLabels(o).map((x) => x.label)
    // Codex
    expect(labels([
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }
    ])).toEqual(['允许', '本次会话内允许', '总是允许', '不允许'])
    // Grok
    expect(labels([
      { optionId: 'a1', name: 'Always', kind: 'allow_always' },
      { optionId: 'a2', name: 'Once', kind: 'allow_once' },
      { optionId: 'r1', name: 'No', kind: 'reject_once' },
      { optionId: 'r2', name: 'Never', kind: 'reject_always' }
    ])).toEqual(['总是允许', '允许', '不允许', '总是拒绝'])
  })

  it('heads a card in Chinese by kind, keeping the agent\'s own title and input as the details', () => {
    expect(permissionText({ title: 'Run command', kind: 'execute', rawInput: { command: 'ls' } })).toEqual({ title: '运行命令', detail: 'Run command\n' + JSON.stringify({ command: 'ls' }, null, 2) })
    expect(permissionText({ title: '写入 notes.md', kind: 'edit' }).title).toBe('写入 notes.md')
    expect(permissionText({ kind: 'fetch' }).title).toBe('访问网络')
  })
})
