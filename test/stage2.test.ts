import { describe, expect, it } from 'vitest'
import { currentBlocker, planProgress, withBlocker } from '../src/shared/model'
import { isSmallTalk } from '../src/main/core/AutoAssigner'
import { planChecklist } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const done = (store: any, id: string, n: number) =>
  until(() => store.messagesOf(id).filter((m: any) => m.role === 'assistant' && m.state === 'done').length >= n && store.conversation(id)?.status === 'idle')

describe('chat titles', () => {
  it('can name a regular chat in its existing turn when the agent has no session-title notification', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_TOOL_TITLE: '启动速度分析' })
    try {
      const c = await core.startChat({ text: '请帮我看看程序为什么启动这么慢', backendId: 'mock' })
      await done(store, c.id, 1)
      expect(store.conversation(c.id)?.title).toBe('启动速度分析')
      expect(store.messagesOf(c.id).filter((m) => m.role === 'user')).toHaveLength(1)
      expect(store.messagesOf(c.id).filter((m) => m.role === 'assistant')).toHaveLength(1)
      // The naming hint belongs to app context, never the user's visible prompt.
      expect(JSON.stringify(store.messagesOf(c.id).filter((m) => m.role === 'assistant'))).not.toContain('当对话首次出现明确主题')
      await core.updateConversation(c.id, { title: '我的启动分析' })
      await core.send(c.id, '继续看看')
      await done(store, c.id, 2)
      expect(store.conversation(c.id)?.title).toBe('我的启动分析')
    } finally { await dispose() }
  }, 30000)
  it.each([false, true])('adopts a backend session title, including after the turn, while respecting manual names (late=%s)', async (late) => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_SESSION_TITLE: '后端概括的主题', ...(late ? { MOCK_LATE_TITLE: '1' } : {}) })
    try {
      const c = await core.startChat({ text: '请帮我仔细分析一下这个程序为何运行缓慢', backendId: 'mock' })
      await done(store, c.id, 1)
      await until(() => store.conversation(c.id)?.title === '后端概括的主题')
      expect(store.conversation(c.id)?.titleAuto).toBe(true)
      await core.updateConversation(c.id, { title: '我自己的名字' })
      await core.send(c.id, '继续分析')
      await done(store, c.id, 2)
      // The delayed notification must have arrived before checking the saved manual name.
      await new Promise((r) => setTimeout(r, 250))
      expect(store.conversation(c.id)?.title).toBe('我自己的名字')
      expect(store.conversation(c.id)?.titleAuto).toBe(false)
    } finally { await dispose() }
  }, 30000)
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
