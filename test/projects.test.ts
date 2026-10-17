import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

describe('projects and threads', () => {
  it('coordinator starts a thread that reports progress and a result', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'openclaude', description: 'desktop app', backendId: 'mock' })
    await core.chat.send(p.conversationId, '帮我调研一下 ACP 协议')

    const thread = await until(() => store.conversations.find((c) => c.kind === 'thread' && c.projectId === p.id))
    expect(thread.title).toContain('调研一下 ACP 协议')
    // The thread card sits on the coordinator's reply.
    const coordMsgs = store.messagesOf(p.conversationId)
    const reply = coordMsgs.find((m) => m.role === 'assistant')!
    expect(reply.blocks.some((b) => b.type === 'thread-card' && b.threadId === thread.id)).toBe(true)
    expect(textOf(reply)).toContain('开始处理')

    const done = await until(() => {
      const t = store.conversation(thread.id)!
      return t.status === 'waiting' && t
    })
    expect(done.checklist).toContain('✓ **整理结论**')
    const visible = store.messagesOf(thread.id).filter((m) => !m.hidden)
    expect(textOf(visible[0])).toBe('我先把需求拆成几步。')
    expect(textOf(visible[visible.length - 1])).toContain('做完了')

    // The coordinator sees thread activity on its next turn and can report it.
    await core.chat.send(p.conversationId, '现在进展如何？')
    const last = store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant').pop()!
    expect(textOf(last)).toContain('调研一下 ACP 协议')
    await dispose()
  }, 30000)

  it('reacts to thanks without a text reply', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    await core.chat.send(p.conversationId, '谢谢！')
    const user = store.messagesOf(p.conversationId).find((m) => m.role === 'user')!
    expect(user.reactions).toEqual(['👍'])
    await dispose()
  })

  it('reopens a resolved thread when the user writes in it', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    await core.chat.send(p.conversationId, '帮我整理文档，完成后解决')
    const t = await until(() => store.conversations.find((c) => c.kind === 'thread' && c.resolved))
    await core.send(t.id, '再补充一点')
    expect(store.conversation(t.id)!.resolved).toBe(false)
    await dispose()
  }, 30000)
})

describe('chats and projects stay apart', () => {
  it('never files a chat into a project, and a message for a project goes to its own chat', async () => {
    const { core, store, dispose } = await makeCore()
    const a = await core.createProject({ name: '园艺', description: '番茄 种植 浇水', backendId: 'mock' })
    const c = await core.startChat({ text: '我的番茄叶子发黄，浇水太多了吗？', backendId: 'mock' })
    await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).length >= 2)
    await new Promise((r) => setTimeout(r, 1500))
    expect(store.conversation(c.id)?.projectId).toBeUndefined()
    await core.updateConversation(c.id, { projectId: a.id })
    expect(store.conversation(c.id)?.projectId).toBeUndefined()
    const into = await core.startChat({ text: '帮我看看番茄', backendId: 'mock', projectId: a.id })
    expect(into.id).toBe(a.conversationId)
    expect(store.conversations.filter((x) => x.kind === 'chat')).toHaveLength(1)
    await dispose()
  }, 30000)

  it('moves chats an earlier version filed into a project back out, under its folder', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'x', backendId: 'mock', cwd: process.cwd() })
    const c = core.chat.createConversation({ kind: 'chat', title: 'old', projectId: p.id, backendId: 'mock' })
    core.separateChatsFromProjects()
    expect(store.conversation(c.id)).toMatchObject({ projectId: undefined, cwd: process.cwd() })
    await dispose()
  })
})

describe('chat titles', () => {
  it('names a new chat after the first exchange', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '周末去哪里爬山比较好？我在杭州', backendId: 'mock' })
    await until(() => store.conversation(c.id)?.title === '周末去哪里爬山比较好')
    await dispose()
  }, 30000)
})

describe('restart', () => {
  it('continues a chat after an app restart with the transcript as context', async () => {
    const first = await makeCore()
    const c = await first.core.startChat({ text: '记住：我的猫叫年糕', backendId: 'mock' })
    await until(() => first.store.messagesOf(c.id).some((m) => m.role === 'assistant' && m.state === 'done'))
    await first.dispose()

    const second = await makeCore(first.dir)
    await second.core.chat.send(c.id, '我的猫叫什么？')
    const last = second.store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()!
    expect(textOf(last)).toContain('之前的对话记录')
    await second.dispose()
  }, 30000)
})

describe('agent crash', () => {
  it('reports a readable error and the chat keeps working afterwards', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await until(() => store.messagesOf(c.id).some((m) => m.role === 'assistant' && m.state === 'done'))
    await core.chat.send(c.id, '/crash')
    const failed = store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()!
    expect(failed.state).toBe('error')
    expect(failed.error).toContain('simulated crash')
    await core.chat.send(c.id, '还在吗？')
    const ok = store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()!
    expect(ok.state).toBe('done')
    expect(textOf(ok)).toContain('之前的对话记录')
    await dispose()
  }, 30000)
})

describe('search', () => {
  it('finds words inside messages across chats and projects', async () => {
    const { core, dispose } = await makeCore()
    const c = await core.startChat({ text: '量子计算的入门书推荐', backendId: 'mock' })
    await until(() => core.store.conversation(c.id)!.status === 'idle' && core.store.messagesOf(c.id).length >= 2)
    const hits = await core.search('入门书')
    expect(hits.some((h) => h.conversationId === c.id && h.role === 'user')).toBe(true)
    expect(await core.search('不存在的词语组合')).toEqual([])
    // One Chinese character is a real query; one Latin letter is not.
    expect((await core.search('量')).some((h) => h.conversationId === c.id)).toBe(true)
    expect(await core.search('a')).toEqual([])
    await dispose()
  }, 30000)
})

describe('export', () => {
  it('renders a conversation as Markdown without hidden messages', async () => {
    const { core, dispose } = await makeCore()
    const p = await core.createProject({ name: '导出', backendId: 'mock' })
    await core.chat.send(p.conversationId, '帮我调研导出格式')
    const md = core.markdownOf(p.conversationId)
    expect(md).toContain('# ')
    expect(md).toContain('帮我调研导出格式')
    expect(md).not.toContain('ancora-context')
    await dispose()
  }, 30000)
})

describe('decision cards', () => {
  it('shows a card with a recommended option and sends the choice back', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '帮我决定发布日期', backendId: 'mock' })
    const card = await until(() => {
      const m = store.messagesOf(c.id).find((x) => x.role === 'assistant' && x.blocks.some((b) => b.type === 'decision'))
      return m && store.conversation(c.id)!.status === 'idle' ? m : undefined
    })
    const idx = card.blocks.findIndex((b) => b.type === 'decision')
    const d = card.blocks[idx] as any
    expect(d.recommended).toBe(0)
    expect(d.options.map((o: any) => o.label)).toEqual(['11 月 1 日', '10 月 25 日'])

    await core.chooseDecision(c.id, card.id, idx, 1)
    expect((store.message(c.id, card.id)!.blocks[idx] as any).chosen).toBe(1)
    await until(() => store.messagesOf(c.id).some((m) => m.role === 'user' && textOf(m).includes('我选：10 月 25 日')))
    // A second tap does nothing.
    await core.chooseDecision(c.id, card.id, idx, 0)
    expect((store.message(c.id, card.id)!.blocks[idx] as any).chosen).toBe(1)
    await dispose()
  }, 30000)
})

describe('pages', () => {
  it('publishes a page and adds versions to it', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '做个页面', backendId: 'mock' })
    const first = await until(() =>
      store.messagesOf(c.id).flatMap((m) => m.blocks).find((b) => b.type === 'artifact') as any
    )
    await until(() => store.conversation(c.id)!.status === 'idle')
    await core.chat.send(c.id, '改一下页面')
    const blocks = store.messagesOf(c.id).flatMap((m) => m.blocks).filter((b) => b.type === 'artifact') as any[]
    expect(blocks.map((b) => b.version)).toEqual([1, 2])
    expect(blocks[1].artifactId).toBe(first.artifactId)
    const info = await core.artifactInfo(first.artifactId)
    expect(info!.versions).toHaveLength(2)
    expect(await core.artifactSource(first.artifactId, 1)).toContain('计数器 v1')
    expect(await core.artifactSource(first.artifactId)).toContain('计数器 v2')
    await dispose()
  }, 30000)
})

describe('sub-conversations', () => {
  it('hands side work to a new chat in the same folder that starts at once and never reports back', async () => {
    const { core, store, dispose } = await makeCore()
    const parent = await core.startChat({ text: '开子对话 降CPU', backendId: 'mock', cwd: process.cwd() })
    const child = await until(() => store.conversations.find((c) => c.parentId === parent.id))
    expect(child).toMatchObject({ kind: 'chat', title: '降CPU', cwd: process.cwd(), backendId: 'mock', handoff: { by: '演示 Agent' } })
    expect(child.handoff!.task).toContain('降CPU')
    // The parent's reply carries a card linking to it; the child is working on the brief, which stays hidden.
    await until(() => store.messagesOf(parent.id).some((m) => m.blocks.some((b) => b.type === 'thread-card' && b.threadId === child.id)))
    await until(() => store.messagesOf(child.id).some((m) => m.role === 'assistant' && m.state === 'done'))
    expect(store.messagesOf(child.id).filter((m) => m.role === 'user' && !m.hidden)).toHaveLength(0)
    const parentMessages = store.messagesOf(parent.id).length
    // The user talks to the child directly; nothing goes back to the parent.
    await core.send(child.id, '继续')
    await until(() => store.messagesOf(child.id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= 2)
    await new Promise((r) => setTimeout(r, 500))
    expect(store.messagesOf(parent.id).length).toBe(parentMessages)
    // No grandchildren: the tool isn't even offered in a child, and the app refuses it anyway.
    const names = (id: string) => (core.orchestrator as any).toolsFor(id).map((x: any) => x.name)
    expect(names(parent.id)).toContain('start_subconversation')
    expect(names(child.id)).not.toContain('start_subconversation')
    expect(() => core.orchestrator.startSubconversation(store.conversation(child.id)!, 'x', 'y')).toThrow()
    await dispose()
  }, 30000)

  it('caps running sub-conversations and refuses them in unattended runs', async () => {
    const { core, store, dispose } = await makeCore()
    const parent = core.chat.createConversation({ kind: 'chat', title: 'p', backendId: 'mock' })
    for (let i = 0; i < 5; i++) {
      const c = core.orchestrator.startSubconversation(parent, `s${i}`, 'task')
      core.chat.patchConversation(c.id, { status: 'waiting' })
    }
    expect(() => core.orchestrator.startSubconversation(store.conversation(parent.id)!, 's5', 'task')).toThrow(/5/)
    const routine = core.chat.createConversation({ kind: 'chat', title: 'r', backendId: 'mock', routineId: 'r1' })
    expect(() => core.orchestrator.startSubconversation(routine, 'x', 'y')).toThrow()
    await dispose()
  }, 30000)

  it('a chat sees its sub-conversations as one snapshot, only when it changed, and can look them up', async () => {
    const { core, store, dispose } = await makeCore()
    const parent = core.chat.createConversation({ kind: 'chat', title: 'p', backendId: 'mock' })
    const child = core.orchestrator.startSubconversation(parent, '查日志', '找出报错的原因')
    await until(() => store.conversation(child.id)!.status !== 'working', 15000)
    const digest = () => (core.orchestrator as any).pendingDigest(store.conversation(parent.id)!) as string
    const first = digest()
    expect(first).toContain('<subconversations>')
    expect(first).toContain('「查日志」')
    expect(digest()).toBe('')
    core.chat.patchConversation(child.id, { status: 'working' })
    expect(digest()).toContain('进行中')
    const tools = (core.orchestrator as any).toolsFor(parent.id)
    const check = tools.find((x: any) => x.name === 'check_subconversations')
    expect(await check.run({})).toContain('「查日志」')
    expect((core.orchestrator as any).toolsFor(child.id).map((x: any) => x.name)).not.toContain('check_subconversations')
    await dispose()
  }, 30000)

  it('/子对话 starts a sub-conversation from the user’s words without a turn here; /讨论串 starts a thread', async () => {
    const { core, store, dispose } = await makeCore()
    const parent = core.chat.createConversation({ kind: 'chat', title: 'p', backendId: 'mock' })
    const id = await core.runCommand(parent.id, 'subchat', '把日志整理一下')
    const child = store.conversation(id)!
    expect(child.parentId).toBe(parent.id)
    expect(child.handoff?.task).toBe('把日志整理一下')
    const msgs = store.messagesOf(parent.id)
    expect(msgs.map((m) => m.role)).toEqual(['user'])
    expect(msgs[0].blocks.some((b) => b.type === 'thread-card')).toBe(true)
    await expect(core.runCommand(parent.id, 'subchat', '  ')).rejects.toThrow()
    await expect(core.runCommand(id, 'subchat', 'x')).rejects.toThrow()
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    const tid = await core.runCommand(p.conversationId, 'thread', '调研竞品定价')
    expect(store.conversation(tid)!.kind).toBe('thread')
    expect(store.messagesOf(p.conversationId).filter((m) => m.role === 'assistant')).toEqual([])
    await dispose()
  }, 30000)
})
