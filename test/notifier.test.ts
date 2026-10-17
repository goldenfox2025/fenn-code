import { describe, expect, it } from 'vitest'
import type { Conversation, NotifyLevel } from '../src/shared/model'
import { Notifier } from '../src/main/core/Notifier'

const conv = (over: Partial<Conversation>): Conversation =>
  ({ id: 'c1', kind: 'thread', title: '调研', status: 'idle', createdAt: 0, updatedAt: 0, ...over }) as Conversation

function setup(focused = false, notify?: NotifyLevel) {
  const shown: { title: string; body: string }[] = []
  const n = new Notifier({
    enabled: () => true,
    focused: () => focused,
    project: (id) => (id ? ({ id: 'p', name: '项目A', notify }) as never : undefined),
    show: (x) => shown.push(x)
  })
  const push = (c: Partial<Conversation>) => n.observe({ type: 'conversation', conversation: conv(c) })
  return { shown, push }
}

describe('notifier', () => {
  it('with 所有新消息, notifies when a thread starts waiting on the user, once', () => {
    const { shown, push } = setup(false, 'all')
    push({ status: 'working', projectId: 'p' })
    push({ status: 'waiting', projectId: 'p', lastPreview: '结论在这里' })
    push({ status: 'waiting', projectId: 'p', lastPreview: '结论在这里' })
    expect(shown).toEqual([{ title: '项目A · 调研', body: '结论在这里', conversationId: 'c1' }])
  })

  it('stays quiet when the window is focused or on first sighting', () => {
    const a = setup(true, 'all')
    a.push({ status: 'working' })
    a.push({ status: 'waiting' })
    expect(a.shown).toHaveLength(0)
    const b = setup(false, 'all')
    b.push({ status: 'waiting' })
    expect(b.shown).toHaveLength(0)
  })

  it('notifies when a chat outside projects finishes a reply', () => {
    const { shown, push } = setup()
    push({ kind: 'chat', status: 'idle' })
    push({ kind: 'chat', status: 'working', updatedAt: 10 })
    push({ kind: 'chat', status: 'idle', updatedAt: 10, lastPreview: '旧的' }) // hidden turn
    push({ kind: 'chat', status: 'working', updatedAt: 20 })
    push({ kind: 'chat', status: 'idle', updatedAt: 30, lastPreview: '好了' })
    expect(shown.map((x) => x.body)).toEqual(['好了'])
  })

  const run = (level: NotifyLevel | undefined) => {
    const { shown, push } = setup(false, level)
    // A thread finishes on its own…
    push({ status: 'working', projectId: 'p' })
    push({ status: 'waiting', projectId: 'p', lastPreview: '查完了' })
    // …the project chat answers…
    push({ id: 'pc', kind: 'project', status: 'idle', projectId: 'p' })
    push({ id: 'pc', kind: 'project', status: 'working', projectId: 'p', updatedAt: 10 })
    push({ id: 'pc', kind: 'project', status: 'idle', projectId: 'p', updatedAt: 20, lastPreview: '协调者回复' })
    // …and a thread asks the user to decide, mid-turn.
    push({ status: 'working', projectId: 'p', updatedAt: 30 })
    push({ status: 'working', projectId: 'p', updatedAt: 30, needsUser: { kind: 'decision', text: '选哪天发布？', at: 1 } })
    push({ status: 'waiting', projectId: 'p', updatedAt: 40, needsUser: { kind: 'decision', text: '选哪天发布？', at: 1 }, lastPreview: '等您选' })
    return shown.map((x) => x.body)
  }

  it('follows the project level: 所有新消息, 协调者与 @提及 (default), 仅 @提及, 无', () => {
    expect(run('all')).toEqual(['查完了', '协调者回复', '需要您决定：选哪天发布？'])
    expect(run(undefined)).toEqual(['协调者回复', '需要您决定：选哪天发布？'])
    expect(run('mentions')).toEqual(['需要您决定：选哪天发布？'])
    expect(run('none')).toEqual([])
  })

  it('a permission prompt is reported once, as needing the user', () => {
    const { shown, push } = setup(false, 'mentions')
    push({ status: 'working', projectId: 'p' })
    push({ status: 'waiting', projectId: 'p', needsUser: { kind: 'permission', text: '运行 npm install', at: 5 } })
    expect(shown.map((x) => x.body)).toEqual(['需要您确认一个操作'])
  })
})
