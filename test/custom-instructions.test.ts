import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

const done = (store: any, id: string, n: number) =>
  until(() => store.conversation(id)?.status === 'idle' && store.messagesOf(id).filter((m: any) => m.role === 'assistant' && m.state === 'done').length >= n, 20000)
const last = (store: any, id: string) =>
  store.messagesOf(id).filter((m: any) => m.role === 'assistant').pop().blocks.map((b: any) => b.text ?? '').join('')

describe('自定义指令 and 项目指令', () => {
  it('reach a plain chat once (in the first message where the agent has no system prompt), not every turn', async () => {
    const t = await makeCore()
    try {
      await t.core.updateSettings({ customInstructions: '回答要简短' })
      const conv = await t.core.startChat({ text: '指令是什么', backendId: 'mock' })
      await done(t.store, conv.id, 1)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：回答要简短')
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 2)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：无')
      // Nothing the user sees.
      expect(t.store.messagesOf(conv.id).filter((m) => m.role === 'user').map((m) => m.blocks.map((b: any) => b.text).join(''))).toEqual(['指令是什么', '指令是什么'])
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('go in as the system prompt where the agent takes one, with the project’s after the user’s own', async () => {
    const t = await makeCore(undefined, { MOCK_SYSTEM_PROMPT: '1' })
    try {
      await t.core.updateSettings({ customInstructions: '用中文' })
      const p = await t.core.createProject({ name: '装修', backendId: 'mock', instructions: '预算十万' })
      const conv = await t.core.startChat({ text: '指令是什么', backendId: 'mock', projectId: p.id })
      await done(t.store, conv.id, 1)
      expect(last(t.store, conv.id)).toBe('系统：用中文|预算十万；本条：无')
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('changed mid-session, reach the agent on its next turn once, and cleared, say so', async () => {
    const t = await makeCore()
    try {
      await t.core.updateSettings({ customInstructions: '旧的' })
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await done(t.store, conv.id, 1)
      await t.core.updateSettings({ customInstructions: '新的' })
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 2)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：新的')
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 3)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：无')
      await t.core.updateSettings({ customInstructions: '' })
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 4)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：已清空')
    } finally {
      await t.dispose()
    }
  }, 60000)

  it('in a system prompt, changed or cleared, move the chat to a new session (a message can’t take them back)', async () => {
    const t = await makeCore(undefined, { MOCK_SYSTEM_PROMPT: '1' })
    try {
      await t.core.updateSettings({ customInstructions: '旧的' })
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await done(t.store, conv.id, 1)
      const first = t.store.conversation(conv.id)!.sessionRef!.sessionId
      await t.core.updateSettings({ customInstructions: '新的' })
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 2)
      expect(last(t.store, conv.id)).toBe('系统：新的；本条：无')
      expect(t.store.conversation(conv.id)!.sessionRef!.sessionId).not.toBe(first)
      await t.core.updateSettings({ customInstructions: '' })
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 3)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：无')
    } finally {
      await t.dispose()
    }
  }, 60000)

  it('come back after the agent compacts, when they were only in the first message', async () => {
    const t = await makeCore()
    try {
      await t.core.updateSettings({ customInstructions: '回答要简短' })
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await done(t.store, conv.id, 1)
      await t.core.send(conv.id, '#压缩 继续')
      await done(t.store, conv.id, 2)
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 3)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：回答要简短')
    } finally {
      await t.dispose()
    }
  }, 60000)

  it('changed while the chat had no live session, reach it when its session is reopened', async () => {
    const t = await makeCore()
    try {
      await t.core.updateSettings({ customInstructions: '旧的' })
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await done(t.store, conv.id, 1)
      t.core.chat.forgetSession(conv.id)
      await t.core.updateSettings({ customInstructions: '新的' })
      await t.core.send(conv.id, '指令是什么')
      await done(t.store, conv.id, 2)
      expect(last(t.store, conv.id)).toBe('系统：无；本条：新的')
    } finally {
      await t.dispose()
    }
  }, 40000)
})
