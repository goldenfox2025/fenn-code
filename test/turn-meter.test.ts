import { describe, expect, it } from 'vitest'
import { TurnMeter } from '../src/main/core/TurnMeter'
import { makeCore, until } from './helpers'

function meter() {
  let now = 0
  const m = new TurnMeter(0, () => now)
  const chunk = (at: number, text = 'x') => { now = at; m.observe({ kind: 'message.delta', text }) }
  return { m, chunk }
}

describe('observed streaming timings', () => {
  it('excludes first-response wait and time after the final chunk', () => {
    const { m, chunk } = meter()
    chunk(1000, '')
    chunk(2000)
    chunk(2200)
    expect(m.finish({ output: 11 }, 'end_turn')).toEqual({ firstResponseMs: 2000, streamMs: 200, outputTokens: 11, tpotMs: 20 })
  })
  it('does not derive TPOT from missing counts, partial replies, a single chunk, or untrusted counts', () => {
    const { m, chunk } = meter()
    expect(m.finish({ output: 10 }, 'end_turn')).toBeUndefined()
    chunk(100)
    expect(m.finish({ output: 10 }, 'end_turn')).toEqual({ firstResponseMs: 100 })
    chunk(200)
    for (const output of [undefined, 0, 1, -1, NaN, Infinity, 1.5]) expect(m.finish({ output }, 'end_turn')?.tpotMs).toBeUndefined()
    expect(m.finish({ output: 10 }, 'cancelled')?.tpotMs).toBeUndefined()
    expect(m.finish({ output: 10 }, 'error')?.tpotMs).toBeUndefined()
    expect(m.finish({ output: 10 }, 'end_turn', false)?.tpotMs).toBeUndefined()
  })
  it('leaves out the time tools run, and gives no speed for waits it cannot account for', () => {
    const { m, chunk } = meter()
    chunk(100)
    // A tool runs from 1000 to 9000 (an approval inside it included): only the model's own time counts.
    chunk(1000)
    m.observe({ kind: 'tool.start', toolId: 't', title: 'tool', status: 'running' })
    m.interrupt()
    chunk(9000, '')
    m.observe({ kind: 'tool.update', toolId: 't', status: 'completed' })
    chunk(9500)
    expect(m.finish({ output: 15 }, 'end_turn')).toEqual({ firstResponseMs: 100, streamMs: 1400, outputTokens: 15, tpotMs: 100 })
    const waited = meter()
    waited.chunk(100)
    waited.m.interrupt()
    waited.chunk(20000)
    expect(waited.m.finish({ output: 10 }, 'end_turn')).toEqual({ firstResponseMs: 100 })
  })
  it('persists reply timings separately from token totals and restores them across restart', async () => {
    const first = await makeCore(undefined, { MOCK_SIMPLE_STREAM: '1' })
    let id: string
    try {
      id = (await first.core.startChat({ text: 'timing', backendId: 'mock' })).id
      await until(() => first.store.conversation(id)?.status === 'idle')
      const reply = first.store.messagesOf(id).find((m) => m.role === 'assistant')!
      expect(reply.timing?.tpotMs).toBeGreaterThan(0)
      expect(first.store.conversation(id)?.timing).toEqual(reply.timing)
      expect(first.store.conversation(id)?.usage?.total).toBe(reply.usage?.total)
    } finally { await first.dispose() }
    const second = await makeCore(first.dir)
    try {
      const reply = second.store.messagesOf(id!).find((m) => m.role === 'assistant')!
      expect(second.store.conversation(id!)?.timing).toEqual(reply.timing)
      expect(reply.timing?.tpotMs).toBeGreaterThan(0)
    } finally { await second.dispose() }
  })
})
