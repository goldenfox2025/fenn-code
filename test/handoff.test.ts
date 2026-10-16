/**
 * What a fresh coordinator session is handed must not depend on the agent
 * cooperating: early facts survive handoffs even when the model saves no
 * memory, the app's own save-memory request never reaches a successor, and
 * the coordinator learns what each thread produced.
 */
import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const lastReply = (store: any, id: string) =>
  textOf(store.messagesOf(id).filter((m: any) => m.role === 'assistant' && !m.hidden).pop())

async function settle(core: any, id: string) {
  await new Promise((r) => setTimeout(r, 300))
  await until(() => !core.chat.isBusy(id), 10000)
}

describe('handoff safety net', () => {
  it('keeps an early fact through repeated handoffs with a model that never saves memory', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_FORGETFUL: '1' })
    core.orchestrator.handoffTurns = 2
    const p = await core.createProject({ name: '暗号', backendId: 'mock' })
    const cid = p.conversationId
    // No 「记住」 here: the app would save that itself, and this test is about the handoff alone.
    await core.chat.send(cid, '暗号是 ZEBRA-42。')
    // Enough turns that the fact falls well outside the recent messages a successor sees verbatim.
    for (const w of Array.from({ length: 22 }, (_, i) => `第 ${i + 1} 句`)) {
      await core.chat.send(cid, w)
      await settle(core, cid)
    }
    expect(core.memory.index(p.id)).not.toContain('ZEBRA-42') // the model saved nothing
    const flushes = store.messagesOf(cid).filter((m) => m.housekeeping && m.role === 'user')
    expect(flushes.length).toBeGreaterThanOrEqual(5)

    core.orchestrator.handoffTurns = 1e9
    core.chat.rotate(cid) // make sure the next turn is a fresh session
    await core.chat.send(cid, '你看到了什么')
    const seen = lastReply(store, cid)
    expect(seen).toContain('<handoff>')
    expect(seen).toContain('ZEBRA-42')
    expect(seen).toContain('<earlier-summary>')
    // The app's save-memory request is never replayed to the successor.
    expect(seen).not.toContain('上下文快满了')
    expect(seen).not.toContain('好了')
    await dispose()
  }, 60000)

  it('answers the user after a handoff instead of acting on the save-memory request', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_FORGETFUL: '1' })
    core.orchestrator.handoffTurns = 2
    const p = await core.createProject({ name: '数数', backendId: 'mock' })
    const cid = p.conversationId
    await core.chat.send(cid, '一')
    await core.chat.send(cid, '二')
    await settle(core, cid)
    core.orchestrator.handoffTurns = 1e9
    await core.chat.send(cid, '你看到了什么')
    const seen = lastReply(store, cid)
    expect(seen).toContain('用户：二')
    expect(seen).not.toContain('上下文快满了')
    expect(lastReply(store, cid)).not.toBe('好了')
    await dispose()
  }, 30000)

  it('tells a fresh coordinator what each thread produced', async () => {
    const first = await makeCore()
    const p = await first.core.createProject({ name: '发布', backendId: 'mock' })
    const cid = p.conversationId
    await first.core.chat.send(cid, '帮我调研竞品定价')
    const thread = () => first.store.conversations.find((c) => c.kind === 'thread' && c.projectId === p.id)
    await until(() => thread()?.status === 'waiting', 20000)
    const result = lastReply(first.store, thread()!.id)
    expect(result).toBeTruthy()
    await first.dispose()

    const second = await makeCore(first.dir)
    await second.core.chat.send(cid, '你看到了什么')
    const seen = lastReply(second.store, cid)
    expect(seen).toContain('最新结果：')
    expect(seen).toContain(result.replace(/\s+/g, ' ').slice(0, 40))
    await second.dispose()
  }, 40000)

  it('keeps the start of a long ordinary chat when replaying it after a restart', async () => {
    const first = await makeCore()
    const c = await first.core.startChat({ text: '我的车牌是 京A-12345', backendId: 'mock' })
    await until(() => !first.core.chat.isBusy(c.id))
    for (let i = 0; i < 6; i++) {
      first.core.chat.addMessage(c.id, 'user', [{ type: 'text', text: `长消息 ${i} ` + '很长的内容'.repeat(1500) }])
      first.core.chat.addMessage(c.id, 'assistant', [{ type: 'text', text: '收到。' }])
    }
    await first.dispose()

    const second = await makeCore(first.dir)
    await second.core.chat.send(c.id, '你看到了什么')
    await until(() => !second.core.chat.isBusy(c.id))
    const seen = lastReply(second.store, c.id)
    expect(seen).toContain('京A-12345')
    await second.dispose()
  }, 60000)
})

describe('long project, long messages', () => {
  it('keeps facts from anywhere in a 200-turn project, even at the end of a long message', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_FORGETFUL: '1' })
    const p = await core.createProject({ name: '长项目', backendId: 'mock' })
    const cid = p.conversationId
    const filler = (i: number) => `第 ${i} 轮的讨论：我们继续看看界面细节，按钮颜色和间距还需要再调一调，整体感觉比上次好一些。`.repeat(4)
    for (let i = 1; i <= 200; i++) {
      let text = filler(i)
      if (i === 1) text = '项目代号是 ZEBRA-42，别忘了。' + text
      if (i === 60) text += '另外，预算是 37 万。'
      if (i === 90) text = filler(i).repeat(6) + '最后说一下：发布日期定在 11 月 3 日。'
      core.chat.addMessage(cid, 'user', [{ type: 'text', text }])
      core.chat.addMessage(cid, 'assistant', [{ type: 'text', text: `好的，第 ${i} 轮收到。` + '我会照这个方向继续推进。'.repeat(5) }])
    }
    core.chat.rotate(cid)
    await core.chat.send(cid, '你看到了什么')
    const seen = lastReply(store, cid)
    expect(seen).toContain('ZEBRA-42')
    expect(seen).toContain('37 万')
    expect(seen).toContain('11 月 3 日')
    await dispose()
  }, 30000)
})

/**
 * QA's phase 6 probe: facts with no dates or numbers, said early in a
 * 350-turn project with a model that never saves memory, must reach every
 * successor. The backend's summary carries them; the heuristic alone must
 * too when summarizing fails.
 */
describe('facts summary across a 350-turn project', () => {
  const FACTS = [
    '项目代号叫青鸟。',
    '我们内部管这个项目叫蓝鲸。',
    'I prefer terse replies, no bullet lists please.',
    '以后回复简短一点，别用列表。',
    '对接人是王磊，有事直接找他。',
    '客户是一家做咖啡的公司，叫山海。',
    '我们最后选了方案乙，不用方案甲。',
    '设计稿由李娜负责。'
  ]
  const CHATTER = [
    '我们继续看看首页的细节，按钮的颜色和间距还需要再调一调，整体感觉比上次好一些，不过标题区域还是有点挤，图片的留白也可以再多一点，这样看起来更舒服，你觉得呢？我们可以先改一版出来再看看效果。',
    '刚才看了一下列表页，滚动的时候有一点卡顿，可能是图片没有压缩，也可能是动画太多了，先把动画去掉试一试，再看看图片的尺寸，如果还是卡就换一种加载方式，慢慢排查，不着急，先把能确定的问题处理掉。',
    '文案这块我又读了一遍，有几处说法太绕了，普通用户可能看不懂，尽量换成大白话，句子短一点，一句话只说一件事，按钮上的字也要直接一点，让人一看就知道点了会发生什么，其他的地方暂时没有问题。'
  ]
  const chatter = (i: number) => (i % 3 === 0 ? `第 ${i} 轮。` : '') + CHATTER[i % CHATTER.length]
  const longWithFact = CHATTER.join('') + CHATTER.join('') + FACTS[7] + CHATTER.join('') + CHATTER.join('')

  async function probe(env: Record<string, string>) {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_FORGETFUL: '1', ...env })
    const p = await core.createProject({ name: '咖啡小程序', backendId: 'mock' })
    const cid = p.conversationId
    let turn = 0
    const add = (text: string) => {
      core.chat.addMessage(cid, 'user', [{ type: 'text', text }])
      core.chat.addMessage(cid, 'assistant', [{ type: 'text', text: '好的，收到。' + '我会照这个方向继续推进。'.repeat(3) }])
      turn++
    }
    for (const [i, f] of FACTS.entries()) {
      add(i === 7 ? longWithFact : f)
      for (let k = 0; k < 4; k++) add(chatter(turn))
    }
    const seenAt: Record<number, string> = {}
    for (const checkpoint of [51, 152, 353]) {
      while (turn < checkpoint - 1) add(chatter(turn))
      // A real turn past the threshold: summary, save-memory request, rotation.
      core.orchestrator.handoffTurns = 1
      await core.chat.send(cid, '继续')
      await core.orchestrator.idle()
      await settle(core, cid)
      core.orchestrator.handoffTurns = 1e9
      core.chat.rotate(cid)
      await core.chat.send(cid, '你看到了什么')
      turn += 2
      seenAt[checkpoint] = lastReply(store, cid)
    }
    return { core, store, p, cid, seenAt, dispose }
  }

  it('keeps all of them through the backend summary', async () => {
    const { core, store, p, cid, seenAt, dispose } = await probe({})
    for (const [at, seen] of Object.entries(seenAt)) {
      expect(seen, `第 ${at} 轮`).toContain('<project-facts>')
      for (const f of FACTS) expect(seen, `第 ${at} 轮：${f}`).toContain(f)
    }
    // Shared with every agent in the project, and kept on the conversation for the next merge.
    expect(core.memory.read(p.id, 'project-facts')?.body).toContain('王磊')
    expect(store.conversation(cid)?.factsSummary).toContain('李娜')
    await dispose()
  }, 120000)

  it('falls back to the app’s own condensing when summarizing fails', async () => {
    const { seenAt, dispose } = await probe({ MOCK_SUMMARY_FAIL: '1' })
    const seen = seenAt[353]
    expect(seen).not.toContain('<project-facts>')
    for (const f of FACTS) expect(seen, f).toContain(f.replace(/[。.]$/, ''))
    // Chatter that only carries a round number no longer crowds out the facts.
    expect(seen).not.toMatch(/用户（要点）：第 \d+ 轮。/)
    await dispose()
  }, 120000)
})
