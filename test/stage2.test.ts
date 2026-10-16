import { describe, expect, it } from 'vitest'
import { currentBlocker, planProgress, withBlocker } from '../src/shared/model'
import { isSmallTalk } from '../src/main/core/AutoAssigner'
import { planChecklist } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const done = (store: any, id: string, n: number) =>
  until(() => store.messagesOf(id).filter((m: any) => m.role === 'assistant' && m.state === 'done').length >= n && store.conversation(id)?.status === 'idle')

describe('chat titles', () => {
  it('stay distinct, and a greeting-only chat is renamed once it has real content', async () => {
    const { core, store, dispose } = await makeCore()
    const a = await core.startChat({ text: '你好', backendId: 'mock' })
    await done(store, a.id, 1)
    await until(() => store.conversation(a.id)?.titleAuto)
    const b = await core.startChat({ text: '你好', backendId: 'mock' })
    await done(store, b.id, 1)
    await until(() => store.conversation(b.id)?.titleAuto)
    expect(store.conversation(a.id)!.title).not.toBe(store.conversation(b.id)!.title)
    await core.send(a.id, '帮我规划去京都的三天行程')
    await done(store, a.id, 2)
    await until(() => store.conversation(a.id)!.title.includes('京都'))
    // A title the user typed is never replaced.
    await core.updateConversation(b.id, { title: '我的标题' })
    await core.send(b.id, '介绍一下量子计算')
    await done(store, b.id, 2)
    await new Promise((r) => setTimeout(r, 800))
    expect(store.conversation(b.id)!.title).toBe('我的标题')
    await dispose()
  }, 60000)

  it('knows small talk', () => {
    expect(isSmallTalk('你好！')).toBe(true)
    expect(isSmallTalk('hello there')).toBe(true)
    expect(isSmallTalk('帮我写一份周报的提纲')).toBe(false)
  })
})

describe('live plan and obstacles', () => {
  it('turns the agent’s ACP plan into the chat’s plan', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '讲讲你会怎么做', backendId: 'mock' })
    await done(store, c.id, 1)
    const p = planProgress(store.conversation(c.id)!.checklist)
    expect(p).toMatchObject({ done: 3, total: 3 })
    expect(planChecklist('T', [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }])).toBe('T\n\n✓ a\n✱ b\n○ c')
    await dispose()
  }, 30000)

  it('records obstacles through set_blocker, keeping earlier ones as history', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '#难点 接口返回 403', backendId: 'mock' })
    await done(store, c.id, 1)
    expect(currentBlocker(store.conversation(c.id)!)?.text).toBe('接口返回 403')
    await core.send(c.id, '#难点 代理证书过期')
    await done(store, c.id, 2)
    const conv = store.conversation(c.id)!
    expect(currentBlocker(conv)?.text).toBe('代理证书过期')
    expect(conv.blockers!.map((b) => [b.text, !!b.resolvedAt])).toEqual([['接口返回 403', true], ['代理证书过期', false]])
    await core.send(c.id, '#难点')
    await done(store, c.id, 3)
    expect(currentBlocker(store.conversation(c.id)!)).toBeUndefined()
    await dispose()
  }, 30000)

  it('withBlocker ignores repeats and keeps a short history', () => {
    let c: { blockers?: any[] } = {}
    c = { blockers: withBlocker(c, 'a', 1) }
    c = { blockers: withBlocker(c, 'a', 2) }
    expect(c.blockers).toHaveLength(1)
    for (let i = 0; i < 20; i++) c = { blockers: withBlocker(c, 'x' + i, 10 + i) }
    expect(c.blockers!.length).toBeLessThanOrEqual(12)
  })
})
