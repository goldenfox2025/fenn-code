import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), endTree: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn }))
vi.mock('../src/main/backends/workspace', async (original) => ({ ...await original<typeof import('../src/main/backends/workspace')>(), endTree: mocks.endTree }))
import { codexEphemeral, codexThreadRequest } from '../src/main/backends/codexControl'

afterEach(() => { vi.clearAllMocks() })
function child() {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123 })
  mocks.spawn.mockReturnValueOnce(proc)
  return proc
}

it('uses native ephemeral mode and stdin for internal requests, never a persisted ACP session', async () => {
  const proc = child()
  let input = ''
  proc.stdin.on('data', (chunk) => { input += chunk.toString() })
  const answer = codexEphemeral('codex.exe', 'Return a short title', { cwd: process.cwd() })
  const args: string[] = mocks.spawn.mock.calls[0][1]
  expect(args).toContain('--ephemeral')
  expect(args).toContain('read-only')
  expect(args).not.toContain('Return a short title')
  expect(input).toContain('Return a short title')
  expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true })
  proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Short title' } }) + '\n')
  proc.emit('exit', 0)
  expect(await answer).toBe('Short title')
})

it('names a specific thread without invoking a model turn', async () => {
  const proc = child()
  const sent: { id?: number; method: string; params: unknown }[] = []
  proc.stdin.on('data', (chunk) => { for (const line of chunk.toString().trim().split('\n')) sent.push(JSON.parse(line)) })
  const result = codexThreadRequest('codex.exe', 'thread/name/set', { threadId: 'owned-thread', name: 'Readable title' })
  proc.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\n')
  proc.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
  await result
  expect(sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/name/set'])
  expect(sent[2].params).toEqual({ threadId: 'owned-thread', name: 'Readable title' })
  expect(sent.some((m) => m.method === 'turn/start')).toBe(false)
})

it('rejects process and pipe failures instead of crashing or returning an empty answer', async () => {
  const proc = child()
  const answer = codexEphemeral('codex.exe', 'title', { cwd: process.cwd() })
  proc.stdin.emit('error', new Error('EPIPE'))
  await expect(answer).rejects.toThrow('EPIPE')
  expect(mocks.endTree).toHaveBeenCalledWith(proc)
})
