import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppListing } from '../src/shared/contract'
import { acpPlugin } from '../src/main/backends/acp'
import { codexAppListing } from '../src/main/backends/plugins/codex'
import { codexRollout, readSessionContext } from '../src/main/backends/sessionLogs'
import { makeCore, until } from './helpers'

const ID = '019a0000-1111-7222-8333-444455556666'
const tokenLine = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 1234 }, model_context_window: 200000 } } })

describe('Codex rollouts, archived or not', () => {
  let home: string
  const saved = process.env.CODEX_HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'oc-codex-'))
    process.env.CODEX_HOME = home
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = saved
  })
  const inSessions = (name = `rollout-2026-10-18T10-00-00-${ID}.jsonl`, body = tokenLine + '\n') => {
    const day = join(home, 'sessions', '2026', '10', '18')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, name), body)
  }
  const inArchive = (name = `rollout-2026-10-18T10-00-00-${ID}.jsonl`, body: string | Buffer = tokenLine + '\n') => {
    mkdirSync(join(home, 'archived_sessions'), { recursive: true })
    writeFileSync(join(home, 'archived_sessions', name), body)
  }

  it('finds a thread in sessions/ or, archived, in archived_sessions/', async () => {
    expect(await codexRollout(ID)).toBeUndefined()
    inArchive()
    expect((await codexRollout(ID))?.archived).toBe(true)
    inSessions()
    expect((await codexRollout(ID))?.archived).toBe(false)
  })

  it('reads the context of an archived chat, and of a compressed one', async () => {
    inArchive()
    expect(await readSessionContext('codex', ID)).toEqual({ used: 1234, size: 200000 })
    const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync
    if (!zstd) return
    const other = ID.replace(/6$/, '7')
    inSessions(`rollout-2026-10-18T11-00-00-${other}.jsonl.zst`, zstd(Buffer.from(tokenLine + '\n')) as unknown as string)
    expect(await readSessionContext('codex', other)).toEqual({ used: 1234, size: 200000 })
  })

  it('archives or unarchives only when the thread is not already so', async () => {
    const runs: string[][] = []
    const listing = codexAppListing(async (_program, args) => void runs.push(args))
    await listing.setShown({}, ID, false)
    expect(runs).toEqual([]) // no rollout: never prompted, Desktop doesn't list it
    inSessions()
    await listing.setShown({}, ID, true)
    await listing.setShown({}, ID, false)
    expect(runs).toEqual([['archive', ID]])
    runs.length = 0
    // Now archived, as `codex archive` leaves it.
    const name = `rollout-2026-10-18T10-00-00-${ID}.jsonl`
    mkdirSync(join(home, 'archived_sessions'), { recursive: true })
    renameSync(join(home, 'sessions', '2026', '10', '18', name), join(home, 'archived_sessions', name))
    await listing.setShown({}, ID, false)
    await listing.setShown({}, ID, true)
    expect(runs).toEqual([['unarchive', ID]])
  })

  it('shows real conversations by default, while retaining an explicit opt-out', () => {
    const listing = codexAppListing(async () => {})
    expect(listing.shown({})).toBe(true)
    expect(listing.shown({ CODEX_SHOW_IN_DESKTOP: '0' })).toBe(false)
    expect(listing.shown({ CODEX_SHOW_IN_DESKTOP: '1' })).toBe(true)
  })

  it('synchronizes the chosen title through the supported metadata API', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const listing = codexAppListing(async () => {}, async (_program, method, params) => { calls.push({ method, params }) })
    await listing.setTitle!({}, ID, '项目主对话')
    expect(calls).toEqual([]) // Never prompted: no stored thread to rename.
    inSessions()
    await listing.setTitle!({}, ID, '项目主对话')
    expect(calls).toEqual([{ method: 'thread/name/set', params: { threadId: ID, name: '项目主对话' } }])
  })
})

/** The demo agent standing in for Codex: its session/delete is logged, and the listing records what it is asked. */
function listedMock(log: string, failing = new Set<string>()) {
  const calls: string[] = []
  const listing: AppListing = {
    app: 'Desktop',
    shown: (config) => config.SHOW === '1',
    setShown: async (_config, sessionId, shown) => {
      calls.push(`${shown ? 'show' : 'hide'} ${sessionId}`)
      if (failing.has(sessionId)) throw new Error('codex not found')
    }
  }
  const plugin = acpPlugin({
    id: 'mock',
    testOnly: true,
    name: 'Mock',
    settings: [{ key: 'SHOW', label: 'show', type: 'toggle', default: '0', noRestart: true }],
    appListing: listing,
    launch: ({ nodeCommand, resourcesDir }) => ({ command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, MOCK_SESSION_LOG: log } })
  })
  return { plugin, calls, failing }
}

const deletes = (log: string) => {
  try {
    return readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('delete '))
  } catch {
    return []
  }
}

describe('conversations kept out of the agent\'s own app (Codex Desktop)', () => {
  it('internal helpers use a native no-history path rather than opening and archiving an ACP session', async () => {
    const native = vi.fn(async () => 'helper answer')
    const plugin = acpPlugin({ id: 'helper', name: 'Helper', isInstalled: () => true, backgroundAsk: native, launch: () => { throw new Error('ACP must not start for a native helper') } })
    const test = await makeCore(undefined, {}, {}, [plugin])
    try {
      expect(await test.core.backends.ask('helper', 'Classify supplied text')).toBe('helper answer')
      expect(native).toHaveBeenCalledOnce()
      expect(test.store.conversations).toEqual([])
    } finally { await test.dispose() }
  })

  it('syncs manual and generated conversation names to the same owned backend session', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-title-sync-')), 'sessions.log')
    const { plugin } = listedMock(log)
    const titles: string[] = []
    plugin.appListing!.setTitle = async (_config, id, title) => { titles.push(`${id}:${title}`) }
    const test = await makeCore(undefined, {}, {}, [plugin])
    try {
      await test.core.setBackendSetting('mock', 'SHOW', '1')
      const conv = await test.core.startChat({ text: 'Hello', backendId: 'mock' })
      await until(() => test.store.conversation(conv.id)?.status === 'idle')
      await test.core.updateConversation(conv.id, { title: 'Readable title' })
      const session = test.store.requireConversation(conv.id).sessionRef!.sessionId
      await until(() => titles.includes(`${session}:Readable title`))
      expect(test.store.requireConversation(conv.id).sessionRef!.sessionId).toBe(session)
    } finally { await test.dispose() }
  }, 30_000)

  it('archives a released session, shows it again before resuming, and follows the setting', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-listing-')), 'sessions.log')
    const { plugin, calls } = listedMock(log)
    const t = await makeCore(undefined, {}, {}, [plugin])
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const sid = t.store.conversation(conv.id)!.sessionRef!.sessionId
      // Released (e.g. the idle cap, a restart of the session): closed and archived in the agent.
      t.core.chat.forgetSession(conv.id)
      await until(() => deletes(log).includes(`delete ${sid}`))
      // The next message resumes it, shown first (an archived Codex thread can't be resumed).
      await t.core.send(conv.id, '再来')
      await until(() => t.store.conversation(conv.id)?.status === 'idle' && t.store.messagesOf(conv.id).filter((m) => m.role === 'assistant').length === 2)
      expect(calls).toContain(`show ${sid}`)
      expect(t.store.conversation(conv.id)!.sessionRef!.sessionId).toBe(sid)

      // Turned on: the open session is released as it now says (not archived), and the sweep shows it.
      calls.length = 0
      const before = deletes(log).length
      await t.core.setBackendSetting('mock', 'SHOW', '1')
      await until(() => calls.includes(`show ${sid}`))
      expect(deletes(log).length).toBe(before)
      // Off again: the released session is hidden by the sweep.
      await t.core.setBackendSetting('mock', 'SHOW', '0')
      await until(() => calls.includes(`hide ${sid}`))
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('hides the session a conversation leaves behind, and touches only its own conversations', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-listing-')), 'sessions.log')
    const { plugin, calls } = listedMock(log)
    const t = await makeCore(undefined, {}, {}, [plugin])
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const sid = t.store.conversation(conv.id)!.sessionRef!.sessionId
      // Quit with it open: never archived in the agent. The next start's sweep hides it.
      await t.core.chat.syncAgentApp()
      expect(calls).toEqual([]) // still open: left alone
      t.core.chat.forgetSession(conv.id)
      await until(() => deletes(log).includes(`delete ${sid}`))
      calls.length = 0
      await t.core.chat.syncAgentApp()
      expect(calls).toEqual([`hide ${sid}`])
      // Dropping a session already archived on release needs nothing more.
      calls.length = 0
      t.core.chat.patchConversation(conv.id, { sessionRef: undefined })
      expect(calls).toEqual([])
      // One from an earlier run (never released in this one), dropped for good (restart, another agent): hidden too.
      t.core.chat.patchConversation(conv.id, { sessionRef: { backendId: 'mock', sessionId: 'earlier-run' } })
      t.core.chat.patchConversation(conv.id, { sessionRef: undefined })
      expect(calls).toEqual(['hide earlier-run'])
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('never deletes a session for agents without an app listing', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-listing-')), 'sessions.log')
    const t = await makeCore(undefined, { MOCK_SESSION_LOG: log })
    try {
      const conv = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle')
      const sid = t.store.conversation(conv.id)!.sessionRef!.sessionId
      t.core.chat.forgetSession(conv.id)
      await new Promise((r) => setTimeout(r, 500))
      expect(deletes(log)).not.toContain(`delete ${sid}`)
    } finally {
      await t.dispose()
    }
  }, 40000)

  it('hides the session of a deleted chat, and tries once more at the next sweep when that fails', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-listing-')), 'sessions.log')
    const { plugin, calls, failing } = listedMock(log)
    const t = await makeCore(undefined, {}, {}, [plugin])
    try {
      const a = await t.core.startChat({ text: '你好', backendId: 'mock' })
      const b = await t.core.startChat({ text: '你好', backendId: 'mock' })
      await until(() => t.store.conversation(a.id)?.status === 'idle' && t.store.conversation(b.id)?.status === 'idle')
      const sa = t.store.conversation(a.id)!.sessionRef!.sessionId
      const sb = t.store.conversation(b.id)!.sessionRef!.sessionId
      // Open when deleted: closed and archived in the agent, nothing more to do.
      await t.core.deleteConversation(a.id)
      await until(() => deletes(log).includes(`delete ${sa}`))
      // Released earlier (as after a restart), then deleted while hiding fails.
      t.core.chat.forgetSession(b.id)
      await until(() => deletes(log).includes(`delete ${sb}`))
      t.core.chat.patchConversation(b.id, { sessionRef: { backendId: 'mock', sessionId: 'from-earlier' } })
      failing.add('from-earlier')
      calls.length = 0
      await t.core.deleteConversation(b.id)
      await until(() => !!t.store.settings.agentAppPending?.length)
      expect(calls).toEqual(['hide from-earlier'])
      expect(t.store.settings.agentAppPending).toEqual([{ backendId: 'mock', sessionId: 'from-earlier' }])
      // The next sweep tries once more, and drops it whatever happens.
      await t.core.chat.syncAgentApp()
      expect(calls).toEqual(['hide from-earlier', 'hide from-earlier'])
      expect(t.store.settings.agentAppPending).toEqual([])
      await t.core.chat.syncAgentApp()
      expect(calls).toHaveLength(2)
    } finally {
      await t.dispose()
    }
  }, 40000)
})
