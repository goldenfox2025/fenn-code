/**
 * Real models are less exact than the demo agent: some never call the app's
 * tools, others call them with loosely shaped arguments. The app must stay
 * usable either way.
 */
import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { normalizeChecklist, obj, rememberRequest, titleFrom } from '../src/main/core/Orchestrator'
import { coerceArgs, findTool, ToolServer, type ToolDef } from '../src/main/tools/ToolServer'
import { makeCore, until } from './helpers'

describe('loosely formatted tool calls', () => {
  const tool = {
    inputSchema: obj(
      { thread_id: { type: 'string' }, text: { type: 'string' }, resolved: { type: 'boolean' }, limit: { type: 'number' } },
      ['thread_id', 'text']
    ),
    aliases: { text: ['message', 'content'] }
  }

  it('maps arguments sent as a string, in other casing, or under other names', () => {
    expect(coerceArgs(tool, '{"threadId":"abc","Message":"hi"}')).toEqual({ thread_id: 'abc', text: 'hi' })
    expect(coerceArgs(tool, { 'thread-id': 'abc', content: ['a', 'b'], resolved: 'false', limit: '5' })).toEqual({
      thread_id: 'abc',
      text: 'a\nb',
      resolved: false,
      limit: 5
    })
    // One stray value for the one missing required text.
    expect(coerceArgs(tool, { thread_id: 'abc', whatever: '补充说明' })).toEqual({ thread_id: 'abc', text: '补充说明' })
  })

  it('finds a tool by a prefixed or differently written name', () => {
    const tools = [{ name: 'start_thread' }, { name: 'update_status' }]
    expect(findTool(tools, 'mcp__openclaude__start_thread')?.name).toBe('start_thread')
    expect(findTool(tools, 'Update-Status')?.name).toBe('update_status')
    expect(findTool(tools, 'openclaude.update_status')?.name).toBe('update_status')
    expect(findTool(tools, 'nope')).toBeUndefined()
  })

  it('serves loose calls over MCP and shows an example when a call still fails', async () => {
    const server = new ToolServer()
    await server.start()
    let got: unknown
    const defs: ToolDef[] = [
      {
        name: 'update_status',
        description: '',
        inputSchema: obj({ text: { type: 'string' } }, ['text']),
        aliases: { text: ['checklist'] },
        example: { text: '任务\n\n✱ 第一步' },
        run: (a) => {
          if (!a.text) throw new Error('参数 text 不能为空')
          got = a
          return 'ok'
        }
      }
    ]
    const ep = server.endpoint('c1', () => defs)
    const call = async (name: string, args: unknown) =>
      (
        await (
          await fetch(ep.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
          })
        ).json()
      ).result
    expect((await call('openclaude__Update_Status', { checklist: ['任务', '', '✓ 一'] })).isError).toBe(false)
    expect(got).toEqual({ text: '任务\n\n✓ 一' })
    const bad = await call('update_status', {})
    expect(bad.isError).toBe(true)
    expect(bad.content[0].text).toContain('正确的调用参数示例')
    server.stop()
  })

  it('turns markdown task lists into the checklist format', () => {
    expect(normalizeChecklist('- [x] 找资料\n- [ ] 写报告', '调研')).toBe('调研\n\n✓ 找资料\n○ 写报告')
    expect(normalizeChecklist('整理\n\n✓ 一\n**✓ 二**\n✱ 三\n○ 四', 'x')).toBe('整理\n\n✓ 一\n**✓ 二**\n✱ 三\n○ 四')
    expect(titleFrom('用户原话：帮我调研三家竞品的定价，越快越好')).toBe('帮我调研三家竞品的定价')
  })
})

describe('a model that never calls the app’s tools', () => {
  it('still gives threads, progress, and remembered facts', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_LAZY: '1' })
    const p = await core.createProject({ name: '懒模型', backendId: 'mock' })
    const cid = p.conversationId

    // The coordinator answers a real task inline instead of starting a thread.
    await core.chat.send(cid, '帮我调研三家竞品的定价')
    const reply = store.messagesOf(cid).filter((m) => m.role === 'assistant' && !m.hidden).pop()!
    expect(textOf(reply).length).toBeGreaterThan(400)
    expect(store.conversations.some((c) => c.kind === 'thread')).toBe(false)

    // The user moves it into a thread; the app starts it without the model's help.
    await core.convertToThread(cid, reply.id)
    const thread = await until(() => store.conversations.find((c) => c.kind === 'thread' && c.projectId === p.id))
    expect(thread.title).toBe('帮我调研三家竞品的定价')
    expect(store.messagesOf(cid).find((m) => m.id === reply.id)?.blocks.some((b) => b.type === 'thread-card')).toBe(true)
    await until(() => store.conversation(thread.id)?.checklist?.includes('正在处理'))
    await until(() => store.conversation(thread.id)?.status === 'waiting', 15000)
    const done = store.conversation(thread.id)!
    expect(done.checklist).toContain('已回复')
    expect(textOf(store.messagesOf(thread.id).find((m) => m.role === 'user')!)).toContain('用户原话：帮我调研三家竞品的定价')

    // "Remember" is kept even though the model never calls memory_write.
    await core.chat.send(cid, '记住：对接人是王磊，有事直接找他。')
    expect(core.memory.index(p.id)).toContain('对接人是王磊')
    expect(core.memory.list(p.id).find((m) => m.body.includes('王磊'))?.name).toBe('对接人是王磊-有事直接找他')
    // Questions and negations aren't saved.
    const before = core.memory.list(p.id).length
    await core.chat.send(cid, '你还记住对接人是谁吗？')
    await core.chat.send(cid, '不用记住这个：暗号是蓝莓。')
    expect(core.memory.list(p.id).length).toBe(before)
    await dispose()
  }, 40000)
})

describe('what counts as asking to remember', () => {
  it('takes instructions to remember, not questions or negations', () => {
    expect(rememberRequest('记住：对接人是王磊，有事直接找他。')).toBe('对接人是王磊，有事直接找他。')
    expect(rememberRequest('请记住我们的预算是 5 万')).toBe('我们的预算是 5 万')
    expect(rememberRequest('别忘了周五要交稿。')).toBe('周五要交稿。')
    expect(rememberRequest('好的。另外，记一下：客户叫山海')).toBe('客户叫山海')
    expect(rememberRequest('Remember: Sarah handles the legal review.')).toBe('Sarah handles the legal review.')
    expect(rememberRequest('Please keep in mind that we use metric units.')).toBe('that we use metric units.')

    for (const no of [
      '你还记住我说的预算吗？',
      '你还记住我说的预算吗',
      '你还记得对接人是谁',
      '不用记住这个，随口一说。',
      '这个别记了',
      '不需要记下来',
      'Do you remember the budget?',
      'No need to remember that.',
      '我记不住这么多事',
      '帮我调研三家竞品的定价'
    ])
      expect(rememberRequest(no), no).toBeUndefined()
  })
})
