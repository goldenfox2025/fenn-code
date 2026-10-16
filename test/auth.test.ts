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
})
