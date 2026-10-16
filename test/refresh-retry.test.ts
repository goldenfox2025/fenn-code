import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

describe('a sign-in being renewed by another process', () => {
  it('retries the turn once by itself instead of failing', async () => {
    const { core, store, dispose } = await makeCore()
    const chat = await core.startChat({ text: '你好 #fail-refresh-once', backendId: 'mock' })
    const reply = await until(() => store.messagesOf(chat.id).find((m) => m.role === 'assistant' && (m.state === 'done' || m.state === 'error')))
    expect(reply.state).toBe('done')
    expect(reply.blocks.some((b) => b.type === 'text' && b.text.length > 0)).toBe(true)
    await dispose()
  }, 30000)
})

describe('a sign-in that cannot be renewed', () => {
  it('shows the backend as needing to sign in again until it works or restarts', async () => {
    const { BackendManager } = await import('../src/main/backends/BackendManager')
    let fail = true
    const fake = {
      id: 'fake',
      name: 'Fake',
      account: async () => ({ installed: true, signedIn: true, detail: 'acct' }),
      create: () => ({
        start: async () => {},
        newSession: async () => ({ sessionId: 's' }),
        prompt: async () =>
          fail ? { stopReason: 'error' as const, error: 'Internal error: Failed to refresh OAuth token: another Fake process is refreshing it' } : { stopReason: 'end_turn' as const },
        cancel: async () => {},
        dispose: async () => {}
      })
    }
    const mgr = new BackendManager({
      plugins: [fake],
      settings: { get: () => ({}), set: () => {} } as never,
      resourcesDir: '.',
      nodeCommand: { command: 'node', env: {} },
      defaultCwd: '.',
      emit: () => {}
    })
    expect((await mgr.account('fake')).signedIn).toBe(true)
    await mgr.prompt('fake', 's', [])
    expect(await mgr.account('fake')).toMatchObject({ signedIn: false, detail: '需要重新登录 · acct' })
    fail = false
    await mgr.prompt('fake', 's', [])
    expect((await mgr.account('fake')).signedIn).toBe(true)
    await mgr.disposeAll()
  })
})
