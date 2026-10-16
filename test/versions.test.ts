import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store/Store'
import { makeCore, until } from './helpers'

const done = (store: Store, id: string, n: number) =>
  until(() => store.messagesOf(id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= n || undefined)
const texts = (store: Store, id: string) =>
  store.messagesOf(id).map((m) => `${m.role}:${m.blocks.find((b) => b.type === 'text')?.type === 'text' ? (m.blocks.find((b) => b.type === 'text') as { text: string }).text.slice(0, 12) : ''}`)

describe('versions of an edited or regenerated turn', () => {
  it('keeps the old turn when a message is edited, and switches between versions', async () => {
    const { core, store, dispose } = await makeCore()
    const chat = await core.startChat({ text: '你好', backendId: 'mock' })
    await done(store, chat.id, 1)
    await core.send(chat.id, '第二个问题')
    await done(store, chat.id, 2)
    const first = texts(store, chat.id)
    const second = store.messagesOf(chat.id).filter((m) => m.role === 'user')[1]

    await core.editMessage(chat.id, second.id, '改过的问题')
    await until(() => store.messagesOf(chat.id).some((m) => m.role === 'user' && m.variant?.count === 2) || undefined)
    await done(store, chat.id, 2)
    const edited = store.messagesOf(chat.id).filter((m) => m.role === 'user')[1]
    expect(edited.variant).toEqual({ group: second.id, index: 1, count: 2 })
    expect(texts(store, chat.id)[2]).toBe('user:改过的问题')

    // Back to the original: the old question and its answer return; the edit is kept aside.
    await core.switchVariant(chat.id, second.id, 0)
    expect(texts(store, chat.id)).toEqual(first)
    expect(store.messagesOf(chat.id)[2].variant).toEqual({ group: second.id, index: 0, count: 2 })
    expect(store.conversation(chat.id)!.sessionRef).toBeUndefined()

    // Regenerating the original adds a third version, and versions survive a reload.
    await core.regenerate(chat.id)
    await until(() => store.messagesOf(chat.id).some((m) => m.variant?.count === 3) || undefined)
    await done(store, chat.id, 2)
    store.flush()
    const again = new Store(store.dir)
    expect(again.messagesOf(chat.id)[2].variant).toEqual({ group: second.id, index: 2, count: 3 })
    expect(again.switchVariant(chat.id, second.id, 1)?.restored[0].blocks).toEqual(edited.blocks)
    await dispose()
  }, 60000)
})

describe('agents correcting an earlier reply', () => {
  it('strikes out the wrong sentence in place, marks it edited, and posts nothing new there', async () => {
    const { core, store, dispose } = await makeCore()
    const chat = await core.startChat({ text: '你好', backendId: 'mock' })
    await done(store, chat.id, 1)
    const before = store.messagesOf(chat.id).find((m) => m.role === 'assistant')!
    await core.send(chat.id, '更正上一条')
    await done(store, chat.id, 2)
    const after = store.message(chat.id, before.id)!
    const text = after.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('~~我的回复是预设的~~ [更正：演示 Agent 的回复都是预设的')
    expect(after.editedAt).toBeGreaterThan(0)
    expect(store.messagesOf(chat.id).filter((m) => m.role === 'assistant')).toHaveLength(2)
    await dispose()
  }, 30000)
})
