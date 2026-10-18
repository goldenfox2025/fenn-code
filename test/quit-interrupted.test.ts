import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store/Store'
import { makeCore, until } from './helpers'

describe('a turn cut off by quitting the app', () => {
  it('stays saved as cut off, so the next launch shows 已中断, not an error', async () => {
    const t = await makeCore()
    const conv = await t.core.startChat({ text: '卡住不动', backendId: 'mock' })
    await until(() => (t.core.chat as any).giveUp.has(conv.id))
    await until(() => t.store.messagesOf(conv.id).some((m) => m.role === 'assistant'))
    // What quitting does: save, then stop the agents (their turns end as the processes go).
    t.store.freeze()
    await t.dispose()
    await new Promise((r) => setTimeout(r, 800))

    const next = new Store(t.dir)
    expect(next.interrupted).toContain(conv.id)
    const last = next.messagesOf(conv.id).filter((m) => m.role === 'assistant').pop()
    // Either dropped (nothing said yet) or kept as cut off; never an error.
    expect(last).toBeDefined()
    if (last) {
      expect(last.state).toBe('cancelled')
      expect(last.interrupted).toBe(true)
    }
  }, 30000)
})
