import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const lastReply = (store: any, id: string) =>
  textOf(store.messagesOf(id).filter((m: any) => m.role === 'assistant' && !m.hidden).pop())

describe('project memory', () => {
  it('agents write memory that survives an app restart', async () => {
    const first = await makeCore()
    const p = await first.core.createProject({ name: 'launch', backendId: 'mock' })
    await first.core.chat.send(p.conversationId, '记住：发布日期定在 11 月 1 日')
    expect(first.core.memory.index(p.id)).toContain('发布日期定在 11 月 1 日')
    await first.dispose()

    const second = await makeCore(first.dir)
    await second.core.chat.send(p.conversationId, '你记得什么？')
    const reply = lastReply(second.store, p.conversationId)
    expect(reply).toContain('（已接手）')
    expect(reply).toContain('发布日期定在 11 月 1 日')
    await second.dispose()
  }, 30000)

  it('hands off to a fresh session when the context gets long, saving memory first', async () => {
    const { core, store, dispose } = await makeCore()
    core.orchestrator.handoffChars = 10
    const p = await core.createProject({ name: 'long', backendId: 'mock' })
    await core.chat.send(p.conversationId, '你好')
    // The housekeeping turn runs hidden right after.
    const hidden = await until(() => {
      const h = store.messagesOf(p.conversationId).filter((m) => m.hidden)
      return h.length >= 2 && h.every((m) => m.state !== 'streaming') && h
    })
    expect(core.memory.index(p.id)).toContain('交接前保存的要点')
    expect(hidden.length).toBe(2)
    expect(store.conversation(p.conversationId)!.sessionRef).toBeUndefined()

    core.orchestrator.handoffChars = 1e9
    await core.chat.send(p.conversationId, '继续')
    expect(lastReply(store, p.conversationId)).toContain('（已接手）')
    await dispose()
  }, 30000)
})

describe('project files', () => {
  it('lets every agent in the project read files the user added', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'docs', backendId: 'mock' })
    await core.addProjectFiles(p.id, [{ name: '../规格.md', data: Buffer.from('# 规格\n登录要支持扫码').toString('base64') }])
    expect((await core.listProjectFiles(p.id)).map((f) => f.name)).toEqual(['规格.md'])
    await core.chat.send(p.conversationId, '看看项目文件')
    expect(lastReply(store, p.conversationId)).toContain('登录要支持扫码')
    await core.deleteProjectFile(p.id, '规格.md')
    expect(await core.listProjectFiles(p.id)).toEqual([])
    await dispose()
  }, 30000)
})
