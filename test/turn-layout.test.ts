import { describe, expect, it } from 'vitest'
import type { Block } from '../src/shared/model'
import { segmentBlocks } from '../src/renderer/src/turn'

const text = (t: string): Block => ({ type: 'text', text: t })
const thought = (t: string, ms = 2000): Block => ({ type: 'thought', text: t, ms })
const tool = (id: string, title = 'Read file.md'): Block => ({ type: 'tool', toolId: id, title, toolKind: 'read', status: 'completed' })
const shape = (blocks: Block[]) => segmentBlocks(blocks).map((g) => (g.type === 'tools' ? `tools:${g.tools.length}` : g.type))

describe('a turn shows what happened, in order: thinking folded, tools on their own lines, text as the reply', () => {
  it('keeps every piece of text as the reply and tools apart from thinking', () => {
    expect(shape([text('我会按发布时间核对。'), thought('…'), tool('a'), text(''), tool('b'), thought('**标题**\n\n再想想'), tool('c'), text('答案')]))
      .toEqual(['text', 'thought', 'tools:2', 'thought', 'tools:1', 'text'])
  })

  it('reads two bouts of thinking with nothing between them as one', () => {
    const [g] = segmentBlocks([thought('一', 1000), thought('二', 2000)])
    expect(g).toMatchObject({ type: 'thought', text: '一\n\n二', ms: 3000 })
  })

  it('puts the plan first and cards last', () => {
    const plan: Block = { type: 'plan', entries: [{ content: 'x', status: 'completed' }] }
    expect(shape([tool('a'), text('答案'), { type: 'thread-card', threadId: 't' }, plan, text('补充')])).toEqual(['plan', 'tools:1', 'text', 'text', 'thread-card'])
  })

  it('leaves out the app’s own tools, which show as cards', () => {
    expect(shape([text('我开一个讨论串给你看。'), tool('s', 'fenn/start_thread'), { type: 'thread-card', threadId: 't' }])).toEqual(['text', 'thread-card'])
  })

  it('keeps an answer the agent thinks again after', () => {
    expect(shape([thought('…'), text('这是答案。'), thought('再想想')])).toEqual(['thought', 'text', 'thought'])
  })
})
