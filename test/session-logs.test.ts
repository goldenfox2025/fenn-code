import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { turnUsage } from '../src/main/backends/acp/AcpBackend'
import { readSessionContext } from '../src/main/backends/sessionLogs'
import { contextLimit } from '../src/shared/modelLimits'

// Shapes as found on a real machine (numbers kept, strings dropped).
const codexLine = (last: number) => JSON.stringify({
  type: 'event_msg',
  payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 250599830, cached_input_tokens: 241764992, output_tokens: 1027607, total_tokens: 251627437 },
    last_token_usage: { input_tokens: 303371, cached_input_tokens: 302848, cache_write_input_tokens: 0, output_tokens: 66, reasoning_output_tokens: 0, total_tokens: last },
    model_context_window: 475000
  } }
})
const claudeLine = (sidechain: boolean, read: number) => JSON.stringify({
  type: 'assistant', isSidechain: sidechain, sessionId: 's', requestId: 'r', message: { id: 'm', model: 'claude-opus-5-5',
    usage: { input_tokens: 2, cache_creation_input_tokens: 3645, cache_read_input_tokens: read, output_tokens: 194 } }
})
const grokLine = (calls: number) => JSON.stringify({
  method: 'session/update', params: { sessionId: 'g1', update: { sessionUpdate: 'turn_completed', usage: {
    inputTokens: 18357, outputTokens: 163, totalTokens: 18520, cachedReadTokens: 1664, cacheCreationTokens: 0, reasoningTokens: 148,
    modelCalls: calls, costUsdTicks: 119666400, modelUsage: { 'grok-4.7-build': {} }, numTurns: 1 } } }
})

describe('reading context from agent session logs', () => {
  const home = mkdtempSync(join(tmpdir(), 'logs-'))
  const day = join(home, '.codex', 'sessions', '2026', '10', '16')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, 'rollout-2026-10-16T01-24-00-aaaa-1111.jsonl'), ['{"type":"session_meta"}', codexLine(1000), codexLine(303437)].join('\n') + '\n')
  writeFileSync(join(day, 'rollout-2026-10-16T02-00-00-bbbb-2222_cccc-3333.jsonl'), codexLine(42) + '\n')
  const proj = join(home, '.claude', 'projects', 'C--work-app')
  mkdirSync(proj, { recursive: true })
  // The last entry is the placeholder Claude Code writes after an interruption; it carries no usage.
  const synthetic = JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
  writeFileSync(join(proj, 'sess-1.jsonl'), [claudeLine(false, 338253), claudeLine(true, 5), synthetic].join('\n'))
  const grok = join(home, '.grok', 'sessions', 'C%3A%5Cwork', 'g1')
  mkdirSync(grok, { recursive: true })
  writeFileSync(join(grok, 'updates.jsonl'), grokLine(1) + '\n')
  const grok2 = join(home, '.grok', 'sessions', 'C%3A%5Cwork', 'g2')
  mkdirSync(grok2, { recursive: true })
  writeFileSync(join(grok2, 'updates.jsonl'), grokLine(3) + '\n')

  it('Codex: the last request against its window, under either id of a two-id file', async () => {
    expect(await readSessionContext('codex', 'aaaa-1111', home)).toEqual({ used: 303437, size: 475000 })
    expect((await readSessionContext('codex', 'cccc-3333', home))?.used).toBe(42)
    expect((await readSessionContext('codex', 'bbbb-2222', home))?.used).toBe(42)
    expect(await readSessionContext('codex', 'nope', home)).toBeUndefined()
  })

  it('Claude Code: input plus cache reads and writes, skipping side chains', async () => {
    expect(await readSessionContext('claude', 'sess-1', home)).toEqual({ used: 2 + 3645 + 338253, model: 'claude-opus-5-5' })
    expect(await readSessionContext('claude', '../x', home)).toBeUndefined()
  })

  it('Grok: the turn from turn_completed; context only when it took one model call', async () => {
    const one = await readSessionContext('grok', 'g1', home)
    expect(one?.used).toBe(18357 + 163)
    expect(one?.model).toBe('grok-4.7-build')
    expect(one?.turn).toMatchObject({ input: 18357 - 1664, output: 163, cachedRead: 1664, thought: 148, cost: { currency: 'USD' } })
    expect(one!.turn!.cost!.amount).toBeCloseTo(0.0119666, 6)
    const many = await readSessionContext('grok', 'g2', home)
    expect(many?.used).toBeUndefined()
    expect(many?.turn?.output).toBe(163)
  })

  it('window sizes from the bundled table, for builds and suffixes too', () => {
    expect(contextLimit('claude-opus-5-5')).toBe(1_000_000)
    expect(contextLimit('sonnet[1m]')).toBe(1_000_000)
    expect(contextLimit('grok-4.7-build')).toBe(500_000)
    expect(contextLimit('gpt-5.5/high')).toBe(1_050_000)
    expect(contextLimit('openai/gpt-5.5')).toBe(1_050_000)
    expect(contextLimit('qoder-auto')).toBeUndefined()
    expect(contextLimit(undefined)).toBeUndefined()
  })

  it('OpenAI-style input counts the cache; it is shown as new input only', () => {
    const res = { usage: { inputTokens: 303098, cachedReadTokens: 302208, outputTokens: 202 } }
    expect(turnUsage(res, true)).toMatchObject({ input: 890, cachedRead: 302208, output: 202 })
    expect(turnUsage(res, false)).toMatchObject({ input: 303098 })
  })
})

describe('the ACP debug log', () => {
  it('is off by default and copies both directions once switched on', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { setAcpDebugLog, tap } = await import('../src/main/backends/acp/debugLog')
    const pass = async (dir: 'in' | 'out') => {
      const s = new Blob([new TextEncoder().encode('{"jsonrpc":"2.0"}\n')]).stream().pipeThrough(tap('Grok', dir))
      return new Response(s).text()
    }
    const folder = mkdtempSync(join(tmpdir(), 'acplog-'))
    expect(await pass('in')).toBe('{"jsonrpc":"2.0"}\n')
    expect(readdirSync(folder)).toEqual([])
    setAcpDebugLog(folder)
    await pass('out')
    setAcpDebugLog(undefined)
    const files = readdirSync(folder)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(folder, files[0]), 'utf8').trim())).toMatchObject({ direction: 'out', text: '{"jsonrpc":"2.0"}\n' })
  })
})
