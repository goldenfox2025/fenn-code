import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

describe('an agent that exits right after starting', () => {
  it('says so with its own stderr, not a bare "connection closed"', async () => {
    const t = await makeCore(undefined, { MOCK_EXIT_AT_START: '1' })
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' }).catch(() => undefined)
      const text = await until(() => {
        const ev = t.events.map((e) => JSON.stringify(e)).find((s) => s.includes('启动后立即退出'))
        if (ev) return ev
        const msgs = conv ? t.store.messagesOf(conv.id) : []
        return msgs.map((m: any) => JSON.stringify(m)).find((s) => s.includes('启动后立即退出'))
      }, 15000)
      expect(text).toContain('code 7')
      expect(text).toContain('missing dependency libfoo')
      expect(text).not.toMatch(/connection closed/i)
    } finally {
      await t.dispose()
    }
  }, 30000)
})
