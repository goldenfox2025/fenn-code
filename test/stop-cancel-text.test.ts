import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

// How agents end a turn the user stopped (QA's stand-ins and the user's screenshot).
const MODES = ['chunk', 'err', 'late', 'end'] as const

describe('a reply the user stopped', () => {
  for (const mode of MODES)
    it(`keeps only what was said before 停止, and shows as stopped (agent ends with ${mode})`, async () => {
      const t = await makeCore(undefined, { MOCK_CANCEL_MODE: mode })
      try {
        const conv = await t.core.startChat({ text: '#慢取消 讲个故事', backendId: 'mock' })
        await until(() => t.store.messagesOf(conv.id).some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'text' && b.text.includes('它不以摧'))))
        await t.core.cancel(conv.id)
        await until(() => t.store.conversation(conv.id)?.status !== 'working')
        await new Promise((r) => setTimeout(r, 200))
        const reply = t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant').pop()!
        expect(reply.state).toBe('cancelled')
        expect(reply.error).toBeUndefined()
        const text = reply.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
        expect(text).toBe('它不以摧')
        expect(t.store.conversation(conv.id)?.status).toBe('idle')
      } finally {
        await t.dispose()
      }
    }, 30000)
})

describe('the cancel note at the end of a stopped reply', () => {
  it('is taken off, whatever the agent’s wording, and nothing else is', async () => {
    const { stripCancelNote } = await import('../src/main/core/ChatService')
    const strip = (text: string) => {
      const m: any = { blocks: [{ type: 'text', text }] }
      stripCancelNote(m)
      return m.blocks.map((b: any) => b.text).join('')
    }
    expect(strip('它不以摧The request was cancelled by the client.')).toBe('它不以摧')
    expect(strip('Half a sentence\n\nRequest has been canceled by user')).toBe('Half a sentence')
    expect(strip('Working… Operation aborted.')).toBe('Working…')
    expect(strip('The request was cancelled by the client.')).toBe('')
    expect(strip('We cancelled the meeting by the client’s request.')).toBe('We cancelled the meeting by the client’s request.')
  })
})
