import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpPlugin } from '../src/main/backends/acp'
import { HarnessReaper, descendants, parseProcessList, type ProcInfo } from '../src/main/backends/harnessReaper'
import { makeCore, until } from './helpers'

const SERVER = 100
const proc = (pid: number, ppid: number, name: string, created: number): ProcInfo => ({ pid, ppid, name, created })

function setup() {
  let clock = 1_000_000
  const procs: ProcInfo[] = [proc(1, 0, 'explorer.exe', 0), proc(SERVER, 1, 'agy_acp_server.exe', 0), proc(101, SERVER, 'agy_acp_server.exe', 0)]
  const killed: number[] = []
  const reaper = new HarnessReaper(async () => procs, (pid) => killed.push(pid), undefined, () => clock)
  return { procs, killed, reaper, tick: (ms: number) => (clock += ms), at: () => clock }
}

describe('ending the localharness program a closed Antigravity session left', () => {
  it('ends the one its session started, by id, and leaves the others', async () => {
    const { procs, killed, reaper, tick, at } = setup()
    const a = reaper.begin()
    tick(500)
    procs.push(proc(201, 101, 'localharness_external.exe', at()))
    tick(1500)
    a('session-a')
    tick(10_000)
    const b = reaper.begin()
    tick(300)
    procs.push(proc(202, 101, 'localharness_external.exe', at()))
    b('session-b')
    tick(10_000)
    expect(await reaper.release('session-a', SERVER)).toEqual([201])
    expect(killed).toEqual([201])
  })

  it('a harness that starts while two sessions open at once belongs to neither, and is left', async () => {
    const { procs, killed, reaper, tick, at } = setup()
    const a = reaper.begin()
    const b = reaper.begin()
    tick(400)
    procs.push(proc(201, 101, 'localharness_external.exe', at()))
    a('session-a')
    b('session-b')
    tick(10_000)
    expect(await reaper.release('session-a', SERVER)).toEqual([])
    expect(killed).toEqual([])
  })

  it('never ends a process outside our server, or one whose id was reused by another program', async () => {
    const { procs, killed, reaper, tick, at } = setup()
    const a = reaper.begin()
    tick(200)
    // Another app's harness, started at the same moment.
    procs.push(proc(300, 1, 'localharness_external.exe', at()))
    procs.push(proc(201, 101, 'localharness_external.exe', at()))
    a('session-a')
    tick(5000)
    // The harness exits on its own, and its id goes to an unrelated program under the server.
    await (reaper as any).attribute(procs, SERVER)
    procs.splice(procs.findIndex((p) => p.pid === 201), 1, proc(201, 101, 'conhost.exe', at()))
    expect(await reaper.release('session-a', SERVER)).toEqual([])
    expect(killed).toEqual([])
  })

  it('finds the whole tree under the server and reads PowerShell’s list', () => {
    const all = [proc(100, 1, 'a', 0), proc(101, 100, 'b', 0), proc(102, 101, 'c', 0), proc(103, 1, 'd', 0)]
    expect(descendants(all, 100).map((p) => p.pid)).toEqual([101, 102])
    expect(parseProcessList('4|0|System|1700000000000\r\n12|4|smss.exe|1700000000001\r\nnoise\r\n')).toEqual([
      proc(4, 0, 'System', 1700000000000),
      proc(12, 4, 'smss.exe', 1700000000001)
    ])
  })
})

describe('an agent that keeps a program per open session', () => {
  it('sees each session open and close, and keeps only its most recent idle sessions open', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-limit-')), 'methods.log')
    const seen: string[] = []
    const limited = acpPlugin({
      id: 'mock',
      testOnly: true,
      name: 'Mock',
      launch: ({ nodeCommand, resourcesDir }) => ({ command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, MOCK_METHOD_LOG: log } }),
      quirks: {
        openSessionLimit: 2,
        sessionTracker: {
          begin: () => (id) => seen.push(`open ${id}`),
          closed: (id) => seen.push(`close ${id}`),
          exited: () => undefined
        }
      }
    })
    const t = await makeCore(undefined, {}, {}, [limited])
    const done = (id: string, n: number) => until(() => t.store.conversation(id)?.status === 'idle' && t.store.messagesOf(id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= n, 20000)
    try {
      const chats: { id: string }[] = []
      for (const text of ['一', '二', '三']) {
        const c = await t.core.startChat({ text, backendId: 'mock' })
        await done(c.id, 1)
        chats.push(c)
      }
      const sessionOf = (id: string) => t.store.conversation(id)!.sessionRef!.sessionId
      // The third chat's turn closed the first (least recently used) chat's session.
      await until(() => readFileSync(log, 'utf8').includes('session/close'))
      expect(seen).toContain(`close ${sessionOf(chats[0].id)}`)
      expect(seen.filter((s) => s.startsWith('close'))).toHaveLength(1)
      // Each session was seen opening (session/new), and only then.
      expect(seen.filter((s) => s === `open ${sessionOf(chats[1].id)}`)).toHaveLength(1)
      // The first chat still answers: its session is opened again.
      await t.core.send(chats[0].id, '再来')
      await done(chats[0].id, 2)
      await until(() => seen.filter((s) => s.startsWith('close')).length === 2)
      expect(seen).toContain(`close ${sessionOf(chats[1].id)}`)
    } finally {
      await t.dispose()
    }
  }, 60000)
})
