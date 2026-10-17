import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'
import { textOf } from '../src/main/core/ChatService'
import type { AppCore } from '../src/main/core/AppCore'
import type { Store } from '../src/main/store/Store'

const done = (store: Store, id: string, n: number) =>
  store.conversation(id)?.status !== 'working' && !store.messagesOf(id).some((m) => m.state === 'streaming') &&
  store.messagesOf(id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= n

async function project(core: AppCore) {
  const p = await core.createProject({ name: 'p', backendId: 'mock' })
  await core.addProjectFiles(p.id, [{ name: '方案.md', data: Buffer.from('# 方案\n先做 A').toString('base64') }])
  return p
}

describe('messages between threads', () => {
  it('hands work over once the other thread has finished its task, with the outputs and a card on both sides', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await project(core)
      const research = core.orchestrator.startThread(p, '调研', '查三家竞品')
      const plan = core.orchestrator.startThread(p, '方案', '#留言 调研 || after_current_task || 方案.md || 调研做完后，请根据方案给出新的解决方案')
      await until(() => done(store, plan.id, 1))
      const sent = store.peerMessages.find((m) => m.fromId === plan.id)!
      expect(sent).toMatchObject({ toId: research.id, deliver: 'after_current_task', hop: 1, outputs: [{ kind: 'file', title: '方案.md' }] })
      const out = store.messagesOf(plan.id).find((m) => m.blocks.some((b) => b.type === 'peer-message' && b.direction === 'out' && b.peerId === sent.id))
      expect(out).toBeTruthy()
      await until(() => done(store, research.id, 2), 20000)
      expect(store.peerMessages.find((m) => m.id === sent.id)?.state).toBe('delivered')
      const list = store.messagesOf(research.id)
      const firstReply = list.findIndex((m) => m.role === 'assistant')
      const card = list.findIndex((m) => m.blocks.some((b) => b.type === 'peer-message' && b.direction === 'in'))
      expect(card).toBeGreaterThan(firstReply)
      const prompt = textOf(list[card + 1])
      expect(prompt).toContain('<peer-message from="讨论串「方案」"')
      expect(prompt).toContain('不是用户的指示')
      expect(prompt).toMatch(/方案\.md：.*方案\.md/)
      expect(list[card + 1].hidden).toBe(true)
    } finally { await dispose() }
  }, 40000)

  it('stops a thread from writing back to the thread whose message started its turn', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await project(core)
      const research = core.orchestrator.startThread(p, '调研', '查三家竞品 完成后解决')
      await until(() => done(store, research.id, 1))
      const plan = core.orchestrator.startThread(p, '方案', '#留言 调研 || now ||  || 收到请回复\n#回信 方案 || now ||  || 谢谢，我也给你留言')
      await until(() => store.peerMessages.some((m) => m.fromId === plan.id && m.state === 'delivered'))
      await until(() => done(store, research.id, 2))
      expect(store.peerMessages.filter((m) => m.fromId === research.id)).toEqual([])
      const reply = store.messagesOf(research.id).filter((m) => m.role === 'assistant').pop()!
      expect(textOf(reply)).toContain('不能再给它')
    } finally { await dispose() }
  }, 40000)

  it('refuses archived projects, fails when the target is deleted, dedupes, caps and cancels', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await project(core)
      const a = core.orchestrator.startThread(p, 'A', '甲')
      const b = core.orchestrator.startThread(p, 'B', '乙')
      await until(() => done(store, a.id, 1) && done(store, b.id, 1))
      // B is waiting on a step: an after-task message waits too.
      core.chat.patchConversation(b.id, { checklist: 'B\n\n✓ 一\n✱ 二', checklistAuto: false })
      const from = store.conversation(a.id)!
      const to = () => store.conversation(b.id)!
      const first = core.peers.send(from, to(), '请接着做')
      expect(first.existing).toBeUndefined()
      expect(core.peers.send(from, to(), '请接着做')).toMatchObject({ existing: true, message: { id: first.message.id } })
      core.peers.send(from, to(), '第二件')
      core.peers.send(from, to(), '第三件')
      expect(() => core.peers.send(from, to(), '第四件')).toThrow('已经有 3 条留言')
      expect(() => core.peers.send(from, from, '自己')).toThrow('不能给自己')
      await core.cancelPeerMessage(first.message.id)
      expect(core.peers.get(first.message.id)?.state).toBe('cancelled')
      await new Promise((r) => setTimeout(r, 300))
      expect(store.peerMessages.filter((m) => m.toId === b.id).map((m) => m.state).sort()).toEqual(['cancelled', 'pending', 'pending'])
      await core.updateProject(p.id, { archived: true })
      expect(() => core.peers.send(from, to(), '归档后')).toThrow('已归档')
      await core.updateProject(p.id, { archived: false })
      await core.deleteConversation(b.id)
      expect(store.peerMessages.filter((m) => m.toId === b.id && m.state === 'failed').map((m) => m.reason)).toEqual(['deleted', 'deleted'])
    } finally { await dispose() }
  }, 40000)

  it('keeps a waiting message across a restart and delivers it once the condition holds', async () => {
    const first = await makeCore()
    let ids: { a: string; b: string; m: string }
    try {
      const p = await project(first.core)
      const a = first.core.orchestrator.startThread(p, 'A', '甲')
      const b = first.core.orchestrator.startThread(p, 'B', '乙')
      await until(() => done(first.store, a.id, 1) && done(first.store, b.id, 1))
      first.core.chat.patchConversation(b.id, { checklist: 'B\n\n✓ 一\n✱ 二', checklistAuto: false })
      const { message } = first.core.peers.send(first.store.conversation(a.id)!, first.store.conversation(b.id)!, '重启后也要送到')
      await new Promise((r) => setTimeout(r, 300))
      expect(first.core.peers.get(message.id)?.state).toBe('pending')
      ids = { a: a.id, b: b.id, m: message.id }
    } finally { await first.dispose() }
    const second = await makeCore(first.dir)
    try {
      expect(second.core.peers.get(ids.m)?.state).toBe('pending')
      expect(second.core.snapshot().peerMessages?.some((m) => m.id === ids.m)).toBe(true)
      second.core.chat.patchConversation(ids.b, { checklist: 'B\n\n✓ 一\n✓ 二' })
      await until(() => second.core.peers.get(ids.m)?.state === 'delivered')
      await until(() => done(second.store, ids.b, 2))
      expect(textOf(second.store.messagesOf(ids.b).filter((m) => m.hidden).pop()!)).toContain('重启后也要送到')
    } finally { await second.dispose() }
  }, 40000)
})
