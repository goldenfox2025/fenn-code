import { describe, expect, it } from 'vitest'
import { turnUsage } from '../src/main/backends/acp/AcpBackend'
import { turnUsageOf } from '../src/main/core/ChatService'
import { addTurn, formatCost, formatTokens, sumTotals } from '../src/shared/usage'
import { makeCore, until } from './helpers'

const idle = (store: any, id: string, n: number) =>
  until(() => store.messagesOf(id).filter((m: any) => m.role === 'assistant' && m.state === 'done').length >= n && store.conversation(id)?.status === 'idle')

describe('reading usage from a prompt response', () => {
  it('takes ACP usage, falls back to a vendor quota field, and never makes numbers up', () => {
    expect(turnUsage({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, thoughtTokens: null } })).toEqual({ input: 10, output: 5, total: 15 })
    // Qoder: only _meta.quota.token_count.
    expect(turnUsage({ _meta: { quota: { token_count: { input_tokens: 7, output_tokens: 3 } } } })).toEqual({ input: 7, output: 3, total: 10 })
    expect(turnUsage({ stopReason: 'end_turn' })).toBeUndefined()
    expect(turnUsage({ usage: { inputTokens: 'x', outputTokens: -1 } })).toBeUndefined()
  })

  it('works out a turn cost from the cumulative session cost', () => {
    const a = { amount: 0.5, currency: 'USD' }
    const b = { amount: 0.75, currency: 'USD' }
    expect(turnUsageOf({ stopReason: 'end_turn' }, a, b)).toEqual({ cost: { amount: 0.25, currency: 'USD' } })
    expect(turnUsageOf({ stopReason: 'end_turn' }, a, a)).toBeUndefined()
    expect(turnUsageOf({ stopReason: 'end_turn' }, undefined, a)).toEqual({ cost: a })
  })

  it('adds turns up and keeps unreported turns apart', () => {
    let t = addTurn(undefined, { input: 10, output: 5, total: 15, cost: { amount: 0.1, currency: 'USD' } })
    t = addTurn(t, undefined)
    t = addTurn(t, { input: 1, output: 1 })
    expect(t).toMatchObject({ input: 11, output: 6, total: 17, turns: 2, unreported: 1, cost: { amount: 0.1, currency: 'USD' } })
    expect(sumTotals([t, undefined, t])).toMatchObject({ total: 34, turns: 4, unreported: 2 })
    // A cost in another currency is not added in, but is counted so the total can say so.
    const mixed = addTurn(t, { input: 1, cost: { amount: 5, currency: 'CNY' } })
    expect(mixed.cost).toEqual({ amount: 0.1, currency: 'USD' })
    expect(mixed.costSkipped).toBe(1)
    expect(formatTokens(1234)).toBe('1,234')
    expect(formatTokens(12345)).toBe('12.3k')
    expect(formatCost({ amount: 0.0123, currency: 'USD' })).toBe('$0.012')
  })
})

describe('usage in conversations', () => {
  it('records each reply’s tokens and cost, and the conversation total', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, c.id, 1)
    await core.send(c.id, '再说一句')
    await idle(store, c.id, 2)
    const replies = store.messagesOf(c.id).filter((m: any) => m.role === 'assistant' && !m.hidden)
    for (const r of replies) {
      expect(r.usage!.total).toBe(r.usage!.input! + r.usage!.output!)
      expect(r.usage!.cost!.currency).toBe('USD')
    }
    const u = await until(() => {
      const x = store.conversation(c.id)!.usage
      return x && x.turns >= 2 ? x : undefined
    })
    const all = store.messagesOf(c.id).filter((m: any) => m.role === 'assistant')
    expect(u.total).toBe(all.reduce((s: number, m: any) => s + (m.usage?.total ?? 0), 0))
    expect(u.unreported).toBe(0)
    expect(u.contextSize).toBe(200000)
    expect(u.cost!.amount).toBeCloseTo(all.reduce((s: number, m: any) => s + (m.usage?.cost?.amount ?? 0), 0), 8)
    await dispose()
  }, 30000)

  it('counts turns the backend reported nothing for, without inventing numbers', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_USAGE: 'none' })
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, c.id, 1)
    const reply = store.messagesOf(c.id).find((m: any) => m.role === 'assistant')!
    expect(reply.usage).toBeUndefined()
    const u = store.conversation(c.id)!.usage!
    expect(u.turns).toBe(0)
    expect(u.unreported).toBeGreaterThan(0)
    expect(u.total).toBe(0)
    await dispose()
  }, 30000)

  it('reads a vendor quota field (as Qoder reports it)', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_USAGE: 'quota' })
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, c.id, 1)
    const reply = store.messagesOf(c.id).find((m: any) => m.role === 'assistant')!
    expect(reply.usage!.output).toBeGreaterThan(0)
    expect(reply.usage!.cost).toBeUndefined()
    await dispose()
  }, 30000)

  it('shows new input plus output, leaving cache reads to the details', () => {
    const t = addTurn(undefined, { input: 2000, output: 400, cachedRead: 160000, total: 162400 })
    expect(t.total).toBe(2400)
    expect(t.cachedRead).toBe(160000)
  })
})
