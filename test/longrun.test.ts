/**
 * The project's long-term state survives many session rotations and an app
 * restart: the coordinator still knows its threads and the project's memory,
 * without relying on any backend session.
 */
import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const visibleReplies = (store: any, id: string) =>
  store.messagesOf(id).filter((m: any) => m.role === 'assistant' && !m.hidden)
const lastReply = (store: any, id: string) => textOf(visibleReplies(store, id).pop())

describe('long-running project', () => {
  it('keeps threads and memory across repeated handoffs and a restart', async () => {
    const first = await makeCore()
    const { core, store } = first
    core.orchestrator.handoffTurns = 2
    const p = await core.createProject({ name: '发布', backendId: 'mock' })
    const cid = p.conversationId

    await core.chat.send(cid, '记住：用户叫小林，偏好中文回复')
    await core.chat.send(cid, '帮我调研竞品定价')
    await core.chat.send(cid, '帮我写发布公告')
    const threads = () => store.conversations.filter((c) => c.kind === 'thread' && c.projectId === p.id)
    await until(() => threads().length === 2 && threads().every((t) => t.status === 'waiting'), 20000)

    // Several more turns, each pair of which forces a handoff to a new session.
    const sessions = new Set<string>()
    for (let i = 0; i < 6; i++) {
      await core.chat.send(cid, `随便聊聊 ${i}`)
      await until(() => !core.chat.isBusy(cid))
      const ref = store.conversation(cid)!.sessionRef
      if (ref) sessions.add(ref.sessionId)
    }
    // At least two memory flushes.
    await until(() => store.messagesOf(cid).filter((m) => m.hidden && m.state !== 'streaming').length >= 4)
    expect(sessions.size).toBeGreaterThanOrEqual(2)

    // Hidden housekeeping never shows up as visible conversation.
    expect(visibleReplies(store, cid).every((m: any) => !textOf(m).includes('上下文快满了'))).toBe(true)
    await first.dispose()

    // Restart: a brand-new process with no live sessions at all.
    const second = await makeCore(first.dir)
    second.core.orchestrator.handoffTurns = 1e9
    await second.core.chat.send(cid, '现在进展如何？')
    const status = lastReply(second.store, cid)
    expect(status).toContain('调研竞品定价')
    expect(status).toContain('写发布公告')

    await second.core.chat.send(cid, '你记得什么？')
    expect(lastReply(second.store, cid)).toContain('用户叫小林')

    // A thread also picks up where it left off after the restart.
    const t = second.store.conversations.find((c) => c.kind === 'thread' && c.title.includes('竞品'))!
    await second.core.send(t.id, '补充：重点看海外')
    await until(() => second.store.conversation(t.id)!.status === 'waiting' && visibleReplies(second.store, t.id).length >= 2, 20000)
    expect(lastReply(second.store, t.id)).toContain('补充：重点看海外')
    await second.dispose()
  }, 90000)
})

describe('restart mid-task', () => {
  it('a thread that was working when the app quit picks its work back up', async () => {
    const first = await makeCore()
    const p = await first.core.createProject({ name: '重启', backendId: 'mock' })
    await first.core.chat.send(p.conversationId, '帮我调研一下断点续做')
    const t = await until(() => first.store.conversations.find((c) => c.kind === 'thread' && c.status === 'working'))
    // Simulate the app dying mid-turn: state is on disk with the thread still working.
    first.store.flush()
    await first.dispose()

    const second = await makeCore(first.dir)
    expect(second.store.interrupted).toContain(t.id)
    second.core.resumeInterrupted()
    await until(() => second.store.conversation(t.id)!.status === 'waiting', 20000)
    expect(second.store.conversation(t.id)!.checklist).toMatch(/✓ \*\*整理结论/)
    await second.dispose()
  }, 40000)
})
