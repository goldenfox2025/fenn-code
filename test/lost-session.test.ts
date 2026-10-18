import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

const replies = (store: any, id: string) => store.messagesOf(id).filter((m: any) => m.role === 'assistant')
const textOf = (m: any) => m.blocks.map((b: any) => b.text ?? '').join('')

describe('a session the agent lost (Antigravity after its helper exits)', () => {
  it('is resumed and the message sent again, with no sign of it in the chat', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-lost-')), 'methods.log')
    const t = await makeCore(undefined, { MOCK_METHOD_LOG: log })
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      await t.core.send(conv.id, '#丢会话 继续')
      await until(() => t.store.conversation(conv.id)?.status !== 'working' && replies(t.store, conv.id).length === 2 && replies(t.store, conv.id)[1].state !== 'streaming')
      const last = replies(t.store, conv.id)[1]
      expect(last.state).toBe('done')
      expect(textOf(last)).not.toMatch(/connection was lost/i)
      expect(t.store.messagesOf(conv.id).filter((m) => m.role === 'user')).toHaveLength(2)
      expect(readFileSync(log, 'utf8').split('\n').filter((l) => l === 'session/resume')).toHaveLength(1)
      // And it keeps working.
      await t.core.send(conv.id, '再来')
      await until(() => replies(t.store, conv.id).length === 3 && replies(t.store, conv.id)[2].state === 'done')
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('opens a new session with the history when the resumed one is lost too', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-lost-')), 'methods.log')
    const t = await makeCore(undefined, { MOCK_METHOD_LOG: log, MOCK_RESUME_LOST: '1' })
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const first = t.store.conversation(conv.id)!.sessionRef!.sessionId
      await t.core.send(conv.id, '#丢会话 继续')
      await until(() => t.store.conversation(conv.id)?.status !== 'working' && replies(t.store, conv.id)[1]?.state && replies(t.store, conv.id)[1].state !== 'streaming')
      expect(replies(t.store, conv.id)[1].state).toBe('done')
      expect(t.store.conversation(conv.id)!.sessionRef!.sessionId).not.toBe(first)
    } finally {
      await t.dispose()
    }
  }, 40000)
})
