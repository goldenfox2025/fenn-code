import { describe, expect, it } from 'vitest'
import { classifyError, limitResetIn } from '../src/shared/errors'
import { makeCore, until } from './helpers'

describe('an agent that says its usage limit was reached as an ordinary reply', () => {
  it('shows it as a failed turn to retry, not as an answer, and leaves it out of speed and usage', async () => {
    const t = await makeCore()
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const before = t.store.conversation(conv.id)!.usage
      await t.core.send(conv.id, '#用量上限')
      await until(() => t.store.conversation(conv.id)?.status === 'error')
      const reply = t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant').pop()!
      expect(reply.state).toBe('error')
      expect(reply.error).toMatch(/Usage Limit Reached/)
      expect(reply.blocks.filter((b) => b.type === 'text')).toEqual([])
      expect(reply.timing).toBeUndefined()
      expect(reply.usage).toBeUndefined()
      expect(t.store.conversation(conv.id)!.usage?.turns).toBe(before?.turns)
    } finally {
      await t.dispose()
    }
  }, 30000)

  it('is recognised, with when it resets', () => {
    const raw = 'Usage Limit Reached. You have reached your usage limit; it will reset in 56 seconds.'
    expect(classifyError(raw)).toBe('limit')
    expect(limitResetIn(raw)).toBe('56 秒')
    expect(limitResetIn('Limit resets in 2 hours')).toBe('2 小时')
    // An answer that merely talks about limits is still an answer.
    expect(classifyError('The API has a rate limit you should handle.')).not.toBe('limit')
  })
})
