import { describe, expect, it } from 'vitest'
import type { Block } from '../src/shared/model'
import { applyEvent } from '../src/main/core/ChatService'

describe('thinking time', () => {
  it('runs from the first thought until anything else arrives', () => {
    const blocks: Block[] = []
    applyEvent(blocks, { kind: 'thought.delta', text: 'hm' } as never, 1000)
    applyEvent(blocks, { kind: 'thought.delta', text: 'm' } as never, 2500)
    applyEvent(blocks, { kind: 'message.delta', text: '你好' } as never, 5200)
    applyEvent(blocks, { kind: 'message.delta', text: '！' } as never, 9000)
    expect(blocks[0]).toMatchObject({ type: 'thought', text: 'hmm', ms: 4200 })
  })
})
