import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'
import { linesOf, textOf } from '../src/main/core/ChatService'
import { referenceContext, resolveReferences } from '../src/main/core/ConversationReferences'

describe('conversation references provide context without dispatching work', { timeout: 30_000 }, () => {
  it('sends evidence to the current chat, preserves references on edit/regenerate and reload, and leaves the referenced worker idle', async () => {
    const h = await makeCore()
    const { core, store } = h
    const p = await core.createProject({ name: 'Project', backendId: 'mock' })
    const worker = core.chat.createConversation({ kind: 'thread', projectId: p.id, title: 'Evidence', backendId: 'mock' })
    core.chat.addMessage(worker.id, 'assistant', [{ type: 'text', text: 'The actual check failed: 130 instead of 70.' }])
    const idle = () => store.requireConversation(p.conversationId).status !== 'working' && store.messagesOf(p.conversationId).some((m) => m.role === 'assistant' && m.state === 'done')
    try {
      await core.send(p.conversationId, '你看到了什么', undefined, [worker.id, worker.id])
      await until(idle)
      const user = store.messagesOf(p.conversationId).find((m) => m.role === 'user')!
      expect(user.references).toEqual([{ id: worker.id, title: 'Evidence' }])
      const reply = store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant').at(-1)!
      expect(textOf(reply)).toContain('<conversation-references>')
      expect(textOf(reply)).toContain('130 instead of 70')
      expect(linesOf([user])[0].text).toContain(`@Evidence (${worker.id})`)
      await core.editMessage(p.conversationId, user.id, '你看到了什么 ')
      await until(idle)
      expect(store.messagesOf(p.conversationId).filter((m) => m.role === 'user').at(-1)?.references).toEqual(user.references)
      await core.regenerate(p.conversationId)
      await until(idle)
      expect(store.messagesOf(p.conversationId).filter((m) => m.role === 'user').at(-1)?.references).toEqual(user.references)
      expect(store.messagesOf(worker.id)).toHaveLength(1)
      expect(store.requireConversation(worker.id).sessionRef).toBeUndefined()
    } finally { await h.dispose() }
    const reload = await makeCore(h.dir)
    try { expect(reload.store.messagesOf(p.conversationId).find((m) => m.role === 'user')?.references?.[0].id).toBe(worker.id) }
    finally { await reload.dispose() }
  })

  it('rejects outside-project/self references and drops deleted evidence at turn time', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'P', backendId: 'mock' })
      const q = await core.createProject({ name: 'Q', backendId: 'mock' })
      expect(() => resolveReferences(store, p.conversationId, [q.conversationId])).toThrow()
      expect(() => resolveReferences(store, p.conversationId, [p.conversationId])).toThrow()
      expect(() => resolveReferences(store, p.conversationId, Array(9).fill(q.conversationId))).toThrow()
      expect(referenceContext(store, p.conversationId, [{ id: 'deleted', title: 'Old evidence' }])).toBe('')
      const worker = core.chat.createConversation({ kind: 'thread', projectId: p.id, title: 'Worker', backendId: 'mock' })
      const first = core.chat.send(p.conversationId, '你好')
      await core.send(p.conversationId, 'queued', undefined, [worker.id])
      await until(() => store.requireConversation(p.conversationId).queued?.length)
      const queued = store.requireConversation(p.conversationId).queued![0]
      expect(queued.references).toEqual([{ id: worker.id, title: 'Worker' }])
      const taken = await core.queuedMessage(p.conversationId, queued.id, 'take')
      expect(taken?.references).toEqual(queued.references)
      await first
      expect(store.requireConversation(worker.id).sessionRef).toBeUndefined()
    } finally { await dispose() }
  })
})
