import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

describe('new projects', () => {
  it('are not pinned', async () => {
    const { core, dispose } = await makeCore()
    const p = await core.createProject({ name: '装修' })
    expect(p.pinned).toBeFalsy()
    await dispose()
  })
})

describe('model before the first message', () => {
  it('remembers each backend’s models and starts a new chat on the one picked', async () => {
    const { core, store, dispose } = await makeCore()
    const a = await core.startChat({ text: '你好', backendId: 'mock' })
    const remembered = await until(() => store.settings.backendModels?.mock)
    expect(remembered.models.map((m) => m.id)).toEqual(['mock-fast', 'mock-smart'])
    expect(remembered.current).toBe('mock-fast')
    await until(() => store.conversation(a.id)?.status === 'idle' && store.conversation(a.id)?.modelId)
    const b = await core.startChat({ text: '你好', backendId: 'mock', modelId: 'mock-smart' })
    await until(() => store.messagesOf(b.id).some((m) => m.role === 'assistant' && m.state === 'done'))
    expect(store.conversation(b.id)!.modelId).toBe('mock-smart')
    const reply = store.messagesOf(b.id).find((m) => m.role === 'assistant')!
    expect(JSON.stringify(reply.blocks)).toContain('mock-smart')
    await dispose()
  }, 30000)
})

describe('demo agent', () => {
  it('greets a new user in plain words, not developer notes', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    const reply = await until(() => store.messagesOf(c.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    const text = JSON.stringify(reply.blocks)
    expect(text).toContain('您好')
    expect(text).toContain('设置 → Agent 后端')
    expect(text).not.toMatch(/ACP|合约|插件/)
    await dispose()
  }, 30000)
})
