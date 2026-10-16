import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'
import { Notifier } from '../src/main/core/Notifier'

const conv = (over: Partial<Conversation>): Conversation =>
  ({ id: 'c1', kind: 'thread', title: '调研', status: 'idle', createdAt: 0, updatedAt: 0, ...over }) as Conversation

function setup(focused = false) {
  const shown: { title: string; body: string }[] = []
  const n = new Notifier({
    enabled: () => true,
    focused: () => focused,
    project: () => ({ id: 'p', name: '项目A' }) as never,
    show: (x) => shown.push(x)
  })
  const push = (c: Partial<Conversation>) => n.observe({ type: 'conversation', conversation: conv(c) })
  return { shown, push }
}

describe('notifier', () => {
  it('notifies when a thread starts waiting on the user, once', () => {
    const { shown, push } = setup()
    push({ status: 'working', projectId: 'p' })
    push({ status: 'waiting', projectId: 'p', lastPreview: '结论在这里' })
    push({ status: 'waiting', projectId: 'p', lastPreview: '结论在这里' })
    expect(shown).toEqual([{ title: '项目A · 调研', body: '结论在这里', conversationId: 'c1' }])
  })

  it('stays quiet when the window is focused or on first sighting', () => {
    const a = setup(true)
    a.push({ status: 'working' })
    a.push({ status: 'waiting' })
    expect(a.shown).toHaveLength(0)
    const b = setup()
    b.push({ status: 'waiting' })
    expect(b.shown).toHaveLength(0)
  })

  it('notifies when a chat reply finishes', () => {
    const { shown, push } = setup()
    push({ kind: 'chat', status: 'idle' })
    push({ kind: 'chat', status: 'working', updatedAt: 10 })
    push({ kind: 'chat', status: 'idle', updatedAt: 10, lastPreview: '旧的' }) // hidden turn
    push({ kind: 'chat', status: 'working', updatedAt: 20 })
    push({ kind: 'chat', status: 'idle', updatedAt: 30, lastPreview: '好了' })
    expect(shown.map((x) => x.body)).toEqual(['好了'])
  })
})
