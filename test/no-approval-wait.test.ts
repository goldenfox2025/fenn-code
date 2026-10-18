import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

const replyOf = (store: any, id: string) =>
  until(() => store.conversation(id)?.status === 'idle' && store.messagesOf(id).find((m: any) => m.role === 'assistant' && m.state === 'done'))
const textOf = (m: any) => m.blocks.map((b: any) => b.text ?? '').join('\n')

describe('the app does not hold work up waiting for an approval', () => {
  it('lets an agent edit files inside the chat’s own folder without asking', async () => {
    const t = await makeCore(undefined, { MOCK_LOCATED: 'inside' })
    const asked: string[] = []
    t.answerWith((r) => (asked.push(r.title), r.options[0].id))
    try {
      const folder = mkdtempSync(join(tmpdir(), 'oc-auto-'))
      const conv = await t.core.startChat({ text: '写一个文件', backendId: 'mock', cwd: folder })
      const reply = await replyOf(t.store, conv.id)
      expect(textOf(reply)).toContain('已获得许可')
      expect(asked).toEqual([])
    } finally {
      await t.dispose()
    }
  }, 30000)

  it('still asks, inline in its chat, for an edit outside the folder', async () => {
    const t = await makeCore(undefined, { MOCK_LOCATED: 'outside' })
    const asked: string[] = []
    t.answerWith((r) => (asked.push(r.title), r.options.find((o) => o.kind === 'reject_once')!.id))
    try {
      const conv = await t.core.startChat({ text: '写一个文件', backendId: 'mock', cwd: mkdtempSync(join(tmpdir(), 'oc-auto-')) })
      const reply = await replyOf(t.store, conv.id)
      expect(asked).toEqual(['写入 notes.md'])
      expect(textOf(reply)).toContain('不写文件')
    } finally {
      await t.dispose()
    }
  }, 30000)

  it('an unattended run (a scheduled task) skips what needs confirming at once, and its reply says so', async () => {
    const t = await makeCore()
    const asked: string[] = []
    t.answerWith((r) => (asked.push(r.title), r.options[0].id))
    try {
      const r = await t.core.saveRoutine({ name: '整理', prompt: '写一份笔记', schedule: { kind: 'interval', minutes: 60 }, target: {}, enabled: true })
      await t.core.scheduler.run(r.id)
      const conv = t.store.conversations.find((c) => c.routineId === r.id)!
      const reply = await replyOf(t.store, conv.id)
      expect(asked).toEqual([])
      expect(textOf(reply)).toContain('不写文件')
      expect(textOf(reply)).toContain('无人值守运行，没有人能确认，已跳过：写入 notes.md')
      expect(t.store.conversation(conv.id)?.needsUser).toBeUndefined()
    } finally {
      await t.dispose()
    }
  }, 30000)
})

describe('a permission prompt waiting for an answer', () => {
  it('is in the snapshot, so a reloaded window shows it again, and leaves it once answered', async () => {
    const t = await makeCore()
    t.answerWith(() => undefined)
    try {
      const conv = await t.core.startChat({ text: '写一个文件', backendId: 'mock' })
      const pending = await until(() => t.core.snapshot().permissions?.find((p) => p.conversationId === conv.id))
      expect(pending.request.title).toBe('写入 notes.md')
      await t.core.respondPermission(pending.request.requestId, pending.request.options[0].id)
      await replyOf(t.store, conv.id)
      expect(t.core.snapshot().permissions).toEqual([])
    } finally {
      await t.dispose()
    }
  }, 30000)
})

describe('停止 with an agent that hangs', () => {
  it('ends the turn within a few seconds even when the agent ignores the cancel, and the next message goes through', async () => {
    const t = await makeCore()
    try {
      const conv = await t.core.startChat({ text: '卡住不动', backendId: 'mock' })
      // The prompt has reached the agent (which now hangs).
      await until(() => (t.core.chat as any).giveUp.has(conv.id))
      const started = Date.now()
      await t.core.cancel(conv.id)
      await until(() => t.store.conversation(conv.id)?.status === 'idle', 20000)
      expect(Date.now() - started).toBeLessThan(15000)
      expect(t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant').pop()?.state).toBe('cancelled')
      await t.core.send(conv.id, '你好')
      await until(() => t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant' && m.state === 'done').length === 1, 20000)
    } finally {
      await t.dispose()
    }
  }, 60000)

  it('never cuts off the next turn: a stop the agent honoured at once leaves the message sent right after alone', async () => {
    const t = await makeCore()
    try {
      const conv = await t.core.startChat({ text: '#啰嗦慢 第一件', backendId: 'mock' })
      await until(() => (t.core.chat as any).giveUp.has(conv.id))
      await t.core.cancel(conv.id)
      await until(() => t.store.conversation(conv.id)?.status !== 'working', 3000)
      // Sent within the stop's grace period; its reply takes longer than that.
      await t.core.send(conv.id, '#啰嗦慢 第二件')
      await until(() => t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant').length === 2 && t.store.conversation(conv.id)?.status === 'idle', 30000)
      const [first, second] = t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant')
      expect(first.state).toBe('cancelled')
      expect(second.state).toBe('done')
    } finally {
      await t.dispose()
    }
  }, 60000)
})

describe('which tool calls go ahead without asking', () => {
  const run = async (env: Record<string, string>, opts: { cwd?: string; settings?: object; routine?: object } = {}) => {
    const t = await makeCore(undefined, env)
    const asked: string[] = []
    t.answerWith((r) => (asked.push(r.title), r.options.find((o) => o.kind === 'reject_once')!.id))
    if (opts.settings) await t.core.updateSettings(opts.settings)
    let id: string
    if (opts.routine) {
      const r = await t.core.saveRoutine({ name: '整理', prompt: '写一份笔记', schedule: { kind: 'interval', minutes: 60 }, target: {}, enabled: true, ...opts.routine })
      await t.core.scheduler.run(r.id)
      id = t.store.conversations.find((c) => c.routineId === r.id)!.id
    } else id = (await t.core.startChat({ text: '写一个文件', backendId: 'mock', cwd: opts.cwd })).id
    const text = textOf(await replyOf(t.store, id))
    await t.dispose()
    return { asked, allowed: text.includes('已获得许可') }
  }
  const folder = () => mkdtempSync(join(tmpdir(), 'oc-pol-'))

  it('a read outside the folder asks in the chat, unless Settings allows such reads', async () => {
    const cwd = folder()
    expect(await run({ MOCK_ASK_KIND: 'read', MOCK_LOCATED_PATH: '/etc/hosts' }, { cwd })).toEqual({ asked: ['写入 notes.md'], allowed: false })
    expect(await run({ MOCK_ASK_KIND: 'read', MOCK_LOCATED_PATH: '/etc/hosts' }, { cwd, settings: { allowOutsideReads: true } })).toEqual({ asked: [], allowed: true })
    expect(await run({ MOCK_ASK_KIND: 'read', MOCK_LOCATED: 'inside' }, { cwd })).toEqual({ asked: [], allowed: true })
  }, 60000)

  it('a link inside the folder that leads outside counts as outside', async () => {
    const cwd = folder()
    const elsewhere = folder()
    mkdirSync(join(elsewhere, 'secret'))
    symlinkSync(join(elsewhere, 'secret'), join(cwd, 'link'))
    expect(await run({ MOCK_LOCATED_PATH: join(cwd, 'link', 'notes.md') }, { cwd })).toEqual({ asked: ['写入 notes.md'], allowed: false })
    expect(await run({ MOCK_LOCATED_PATH: join(cwd, 'new', 'notes.md') }, { cwd })).toEqual({ asked: [], allowed: true })
  }, 60000)

  it('a scheduled task runs commands only when its 允许运行命令 is on, and never waits', async () => {
    expect(await run({ MOCK_ASK_KIND: 'execute' }, { routine: {} })).toEqual({ asked: [], allowed: false })
    expect(await run({ MOCK_ASK_KIND: 'execute' }, { routine: { allowCommands: true } })).toEqual({ asked: [], allowed: true })
    // Outside reads are refused there too.
    expect(await run({ MOCK_ASK_KIND: 'read', MOCK_LOCATED_PATH: '/etc/hosts' }, { routine: {} })).toEqual({ asked: [], allowed: false })
  }, 90000)
})
