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
    chunk(2600)
    chunk(3200)
    expect(m.finish({ output: 11 }, 'end_turn')).toEqual({ firstResponseMs: 2000, streamMs: 1200, outputTokens: 11, tpotMs: 120 })
  })
  it('gives a reply that arrives in a burst or a few chunks no speed, never one timed from the send', () => {
    // Antigravity: two chunks 7 ms apart after 4.4 s of waiting. Timed from the send this read as 1.8 tok/s.
    const agy = meter()
    agy.chunk(4438, 'Hi')
    agy.chunk(4445, ' there')
    expect(agy.m.finish({ output: 8 }, 'end_turn')).toEqual({ firstResponseMs: 4438, outputTokens: 8, noSpeed: 'short' })
    // Codex buffers its output: many chunks within a few milliseconds.
    const burst = meter()
    for (let i = 0; i < 40; i++) burst.chunk(1000 + i)
    expect(burst.m.finish({ output: 380 }, 'end_turn')).toEqual({ firstResponseMs: 1000, outputTokens: 380, noSpeed: 'short' })
    // Two chunks far apart are still too few to say how fast the model writes.
    const two = meter()
    two.chunk(100)
    two.chunk(5000)
    expect(two.m.finish({ output: 50 }, 'end_turn')?.noSpeed).toBe('short')
  })
  it('does not derive TPOT from missing counts, partial replies, a single chunk, or untrusted counts', () => {
    const { m, chunk } = meter()
    expect(m.finish({ output: 10 }, 'end_turn')).toBeUndefined()
    chunk(100)
    expect(m.finish({ output: 10 }, 'end_turn')).toEqual({ firstResponseMs: 100, outputTokens: 10, noSpeed: 'short' })
    chunk(1200)
    chunk(2200)
    for (const output of [undefined, 0, 1, -1, NaN, Infinity, 1.5]) expect(m.finish({ output }, 'end_turn')?.tpotMs).toBeUndefined()
    expect(m.finish({ output: 10 }, 'cancelled')?.tpotMs).toBeUndefined()
    expect(m.finish({ output: 10 }, 'error')?.tpotMs).toBeUndefined()
    expect(m.finish({ output: 10 }, 'end_turn', false)?.tpotMs).toBeUndefined()
    // Each says why, for the reply's tooltip.
    expect(m.finish({ output: 10 }, 'cancelled')?.noSpeed).toBe('stopped')
    expect(m.finish({}, 'end_turn')?.outputChars).toBe(3)
    const silent = meter()
    silent.chunk(100, '.')
    silent.chunk(5000, '')
    expect(silent.m.finish({}, 'end_turn')?.noSpeed).toBe('output')
  })
  it('without a token count, measures the text as it streamed in characters per second, never from the send', () => {
    const { m, chunk } = meter()
    chunk(11500, '嗨！')
    chunk(12000, '有什么')
    chunk(13500, '我可以帮你的吗？')
    expect(m.finish({}, 'end_turn')).toEqual({ firstResponseMs: 11500, streamMs: 2000, outputChars: 13 })
    const burst = meter()
    burst.chunk(11500, '嗨！有什么我可以帮你的吗？')
    burst.chunk(11520, '\n')
    expect(burst.m.finish({}, 'end_turn')).toEqual({ firstResponseMs: 11500, noSpeed: 'short' })
    const few = meter()
    few.chunk(100, '你好')
    few.chunk(3000, '世界')
    expect(few.m.finish({}, 'end_turn')?.noSpeed).toBe('short')
  })
  it('times the reply text alone: thinking before it is not in the output count', () => {
    // Antigravity on the PC: thinking streamed for ~4.5 s, then a one-line reply. Timed with the thinking it read 3.3 tok/s.
    let now = 0
    const m = new TurnMeter(0, () => now)
    const thought = (at: number) => { now = at; m.observe({ kind: 'thought.delta', text: 'hmm' }) }
    const reply = (at: number, text = 'x') => { now = at; m.observe({ kind: 'message.delta', text }) }
    for (let at = 500; at <= 5000; at += 500) thought(at)
    reply(5010, 'Hi!')
    reply(5020, ' How can I help?')
    expect(m.finish({ input: 13700, output: 15 }, 'end_turn')).toEqual({ firstResponseMs: 500, outputTokens: 15, noSpeed: 'short' })
    // Thinking, then a reply that really streams: its speed covers the reply only.
    let t2 = 0
    const n = new TurnMeter(0, () => t2)
    for (let at = 100; at <= 4000; at += 100) { t2 = at; n.observe({ kind: 'thought.delta', text: 'a' }) }
    for (const at of [5000, 5600, 6000]) { t2 = at; n.observe({ kind: 'message.delta', text: 'b' }) }
    expect(n.finish({ output: 21 }, 'end_turn')).toEqual({ firstResponseMs: 100, streamMs: 1000, outputTokens: 21, tpotMs: 50 })
  })
  it('does not take a tool that ran after the last reply text out of the stream', () => {
    let now = 0
    const m = new TurnMeter(0, () => now)
    for (const at of [100, 700, 1300]) { now = at; m.observe({ kind: 'message.delta', text: 'x' }) }
    now = 1400
    m.observe({ kind: 'tool.start', toolId: 't', title: 'tool', status: 'running' })
    now = 9000
    m.observe({ kind: 'tool.update', toolId: 't', status: 'completed' })
    expect(m.finish({ output: 13 }, 'end_turn')).toEqual({ firstResponseMs: 100, streamMs: 1200, outputTokens: 13, tpotMs: 100 })
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
    expect(waited.m.finish({ output: 10 }, 'end_turn')).toEqual({ firstResponseMs: 100, outputTokens: 10, noSpeed: 'waited' })
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
