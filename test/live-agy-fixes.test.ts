import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'
import type { PermissionRequest } from '../src/shared/contract'
import { ComputerControl } from '../src/main/computer/ComputerControl'
import type { AppRef, InputDriver } from '../src/main/computer/drivers'
import { settledTitle } from '../src/renderer/src/toolTitle'
import { reportedInput } from '../src/shared/usage'
import { makeCore, until } from './helpers'

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
})
