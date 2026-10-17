import { describe, expect, it } from 'vitest'
import type { Block } from '../src/shared/model'
import { groupBlocks } from '../src/renderer/src/turn'

const text = (t: string): Block => ({ type: 'text', text: t })
const thought = (t: string): Block => ({ type: 'thought', text: t, ms: 2000 })
const tool = (id: string, title = 'Read file.md'): Block => ({ type: 'tool', toolId: id, title, toolKind: 'read', status: 'completed' })

describe('a turn shows one steps line, then the answer', () => {
  it('folds chatty text between tool calls into the steps, even from an agent that narrates every move', () => {
    // A talkative agent: an ack, thinking, a plan of what it will do, two tools, then the answer.
    const blocks = [text('收到，先在这里留一句。'), thought('…'), text('我先更新进度，再用一两句话确认。'), tool('a'), tool('b'), text('这个讨论串已经在看板上。')]
    const groups = groupBlocks(blocks)
    expect(groups).toHaveLength(2)
    expect(Array.isArray(groups[0])).toBe(true)
    expect((groups[0] as Block[]).map((b) => b.type)).toEqual(['text', 'thought', 'text', 'tool', 'tool'])
    expect(groups[1]).toEqual(text('这个讨论串已经在看板上。'))
  })

  it('keeps text after the last step as the answer, and cards after it', () => {
    const groups = groupBlocks([tool('a'), text('答案'), { type: 'thread-card', threadId: 't' }, text('补充')])
    expect(groups.map((g) => (Array.isArray(g) ? 'steps' : g.type))).toEqual(['steps', 'text', 'text', 'thread-card'])
  })

  it('does not fold text before the app’s own tools, which show as cards', () => {
    const groups = groupBlocks([text('我开一个讨论串给你看。'), tool('s', 'ancora/start_thread'), { type: 'thread-card', threadId: 't' }])
    expect(groups.map((g) => (Array.isArray(g) ? 'steps' : g.type))).toEqual(['text', 'thread-card'])
  })

  it('keeps an answer the agent thinks again after (no tool follows it)', () => {
    const groups = groupBlocks([thought('…'), text('这是答案。'), thought('再想想')])
    expect(groups.map((g) => (Array.isArray(g) ? 'steps' : g.type))).toEqual(['steps', 'text'])
    expect((groups[0] as Block[]).map((b) => b.type)).toEqual(['thought', 'thought'])
  })

  it('shows streaming text inline until a tool follows it', () => {
    expect(groupBlocks([thought('…'), text('正在写')]).map((g) => (Array.isArray(g) ? 'steps' : g.type))).toEqual(['steps', 'text'])
  })
})
