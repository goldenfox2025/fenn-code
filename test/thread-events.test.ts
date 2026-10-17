import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'
import { linesOf, textOf } from '../src/main/core/ChatService'
import type { Store } from '../src/main/store/Store'

const done = (store: Store, id: string, n: number) =>
  store.conversation(id)?.status !== 'working' && !store.messagesOf(id).some((m) => m.state === 'streaming') &&
  store.messagesOf(id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= n

describe('thread events reach the coordinator as one fresh list, not a pile of notices', () => {
  it('shows a finished thread with its result once, then nothing while the list is unchanged', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'p', backendId: 'mock' })
      const research = core.orchestrator.startThread(p, '竞品调研', '查三家竞品 完成后解决')
      await until(() => done(store, research.id, 1) && store.conversation(research.id)?.resolved)
      await core.send(p.conversationId, '你看到了什么')
      await until(() => done(store, p.conversationId, 1))
      const first = textOf(store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant').pop()!)
      expect(first).toContain('<threads>')
      expect(first).toMatch(/「竞品调研」 id:\w+ 已解决\n {2}最新结果：做完了/)
      expect(first).not.toContain('thread-updates')
      await core.send(p.conversationId, '你看到了什么')
      await until(() => done(store, p.conversationId, 2))
      const second = textOf(store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant').pop()!)
      expect(second).not.toContain('<threads>')
    } finally { await dispose() }
  }, 40000)

  it('a thread asking the user to decide shows a line in the project chat that no agent sees', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'p', backendId: 'mock' })
      const th = core.orchestrator.startThread(p, '发布日期', '帮我决定发布日期')
      await until(() => done(store, th.id, 1))
      const line = await until(() => store.messagesOf(p.conversationId).find((m) => m.blocks.some((b) => b.type === 'thread-event')))
      expect(line.role).toBe('system')
      expect(line.blocks[0]).toMatchObject({ type: 'thread-event', threadId: th.id, kind: 'decision', text: '发布日期定在哪天？' })
      expect(linesOf(store.messagesOf(p.conversationId)).some((l) => l.text.includes('发布日期定在哪天'))).toBe(false)
      await core.send(p.conversationId, '你看到了什么')
      await until(() => done(store, p.conversationId, 1))
      expect(textOf(store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant').pop()!)).toMatch(/「发布日期」 id:\w+ 等用户决定/)
    } finally { await dispose() }
  }, 40000)
})
