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
      core.orchestrator.reviews.onSubmitted = undefined
      const p = await core.createProject({ name: 'p', backendId: 'mock' })
      const research = core.orchestrator.startThread(p, '竞品调研', '查三家竞品 完成后解决')
      await until(() => done(store, research.id, 1) && store.conversation(research.id)?.review?.state === 'pending')
      await core.send(p.conversationId, '你看到了什么')
      await until(() => done(store, p.conversationId, 1))
      const first = textOf(store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant').pop()!)
      expect(first).toContain('<threads>')
      expect(first).toMatch(/「竞品调研」 id:\w+ 待验收 revision:.*\n {2}最新结果：做完了/)
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

  it('an explicit legacy forward hands the message to a thread and leaves a historical line', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'p', backendId: 'mock' })
      const th = core.orchestrator.startThread(p, '调研', '查三家竞品 完成后解决')
      await until(() => done(store, th.id, 1) && store.conversation(th.id)?.review?.state === 'pending')
      const revision = store.requireConversation(th.id).review!.id
      await core.orchestrator.reviews.recommend(th.id, revision, 'ready', 'Fixture review')
      await core.acceptDelivery(th.id, revision)
      await core.sendToThread(p.conversationId, th.id, '再加一家：D 公司')
      await until(() => done(store, th.id, 2))
      expect(store.conversation(th.id)?.resolved).toBe(false) // reopened for the new work
      const mine = store.messagesOf(th.id).filter((m) => m.role === 'user' && !m.hidden)
      expect(mine.map(textOf)).toEqual(['再加一家：D 公司'])
      const line = store.messagesOf(p.conversationId).find((m) => m.blocks.some((b) => b.type === 'thread-event'))!
      expect(line).toMatchObject({ role: 'system', blocks: [{ type: 'thread-event', kind: 'forwarded', threadId: th.id, text: '再加一家：D 公司' }] })
      await until(() => store.conversation(p.conversationId)?.status === 'idle' && !store.requireConversation(th.id).review?.decisionPending)
      const coordinatorLines = linesOf(store.messagesOf(p.conversationId))
      expect(JSON.stringify(coordinatorLines)).not.toContain('再加一家：D 公司')
      expect(JSON.stringify(coordinatorLines)).toContain('用户已作出验收决定')
      expect(store.conversation(p.conversationId)?.status).toBe('idle')
      await expect(core.sendToThread(p.conversationId, p.conversationId, 'x')).rejects.toThrow()
    } finally { await dispose() }
  }, 40000)

  it('marks what needs the user in person, and clears it once they answer', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'p', backendId: 'mock' })
      await core.updateProject(p.id, { notify: 'mentions' })
      expect(store.project(p.id)?.notify).toBe('mentions')
      const th = core.orchestrator.startThread(p, '发布日期', '帮我决定发布日期')
      await until(() => done(store, th.id, 1))
      expect(store.conversation(th.id)?.needsUser).toMatchObject({ kind: 'decision', text: '发布日期定在哪天？' })
      const card = store.messagesOf(th.id).find((m) => m.blocks.some((b) => b.type === 'decision'))!
      await core.chooseDecision(th.id, card.id, card.blocks.findIndex((b) => b.type === 'decision'), 0)
      expect(store.conversation(th.id)?.needsUser).toBeUndefined()
    } finally { await dispose() }
  }, 40000)
})
