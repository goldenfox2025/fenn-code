import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { makeCore } from './helpers'

describe('backend sign-in', () => {
  it('explains how to sign in, and works after the in-app login', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_AUTH: '1' })
    const conv = await core.startChat({ text: '你好', backendId: 'mock' })
    await new Promise((r) => setTimeout(r, 1500))
    const failed = store.messagesOf(conv.id).find((m) => m.role === 'assistant')!
    expect(failed.state).toBe('error')
    expect(failed.error).toContain('需要登录')
    expect(failed.error).toContain('登录')

    const methods = await core.backendAuthMethods('mock')
    expect(methods.map((m) => m.id)).toEqual(['mock-login'])
    await core.backendLogin('mock', 'mock-login')

    await core.chat.send(conv.id, '再试一次')
    const ok = store.messagesOf(conv.id).filter((m) => m.role === 'assistant').pop()!
    expect(ok.state).toBe('done')
    expect(textOf(ok)).toContain('再试一次')
    await dispose()
  }, 30000)

  it('reads a signed-out agent as needing sign-in when loading models early, without throwing', async () => {
    const { core, dispose } = await makeCore(undefined, { MOCK_AUTH: '1' })
    const catalog = await core.backendModels('mock')
    expect(catalog).toEqual({ models: [], needsLogin: true })
    await expect(core.setModelDefault('mock', 'mock-smart')).rejects.toThrow(/需要登录/)
    // Signing in makes the models available.
    await core.backendLogin('mock', 'mock-login')
    expect((await core.backendModels('mock')).models.length).toBeGreaterThan(0)
    await dispose()
  }, 30000)
})

