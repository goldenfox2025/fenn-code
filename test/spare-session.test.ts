import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acpPlugin } from '../src/main/backends/acp'
import { makeCore, until } from './helpers'

// The mock agent, set up the way Antigravity is: slow to open a session, and it opens on the model it was started with.
const slowSessions = acpPlugin({
  id: 'mock',
  testOnly: true,
  name: 'Mock',
  launch: ({ nodeCommand, resourcesDir, defaultModel }) => ({
    command: nodeCommand.command,
    args: [join(resourcesDir, 'mock-agent.mjs')],
    env: { ...nodeCommand.env, MOCK_DEFAULT_MODEL: defaultModel?.() }
  }),
  quirks: { spareSession: true, modelAtStart: true }
})

interface Spare { id: string; sessionId?: string; info: Promise<{ sessionId: string; currentModelId?: string } | undefined> }
const sparesOf = (core: { chat: unknown }) => (core.chat as unknown as { spares: Map<string, Spare> }).spares
/** The spare once its session is open (and, with `not`, a different one). */
const opened = (core: { chat: unknown }, not?: string) => until((): Spare | undefined => {
  const s = sparesOf(core).get('mock')
  return s?.sessionId && s.sessionId !== not ? s : undefined
})

// Antigravity's own quirks: its first session warms it up too.
const agyLike = acpPlugin({
  id: 'mock',
  testOnly: true,
  name: 'Mock',
  launch: ({ nodeCommand, resourcesDir, defaultModel }) => ({
    command: nodeCommand.command,
    args: [join(resourcesDir, 'mock-agent.mjs')],
    env: { ...nodeCommand.env, MOCK_DEFAULT_MODEL: defaultModel?.() }
  }),
  quirks: { warmSession: true, spareSession: true, modelAtStart: true }
})

describe('a session opened ahead for the next new chat', () => {
  it('is the only session the new-chat page, its model list and the first message open (PC check on RC21)', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'oc-methods-')), 'methods.log')
    const t = await makeCore(undefined, { MOCK_METHOD_LOG: log }, {}, [agyLike])
    const count = (method: string) => { try { return readFileSync(log, 'utf8').split('\n').filter((l) => l === method).length } catch { return 0 } }
    try {
      // The app starts it ahead; then the new-chat page shows it, with no folder, and its model picker asks for the models.
      await t.core.prestartBackends()
      await t.core.warmBackend('mock', '')
      const catalog = await t.core.backendModels('mock')
      expect(catalog.models.length).toBeGreaterThan(0)
      await opened(t.core)
      expect(count('session/new')).toBe(1)
      const conv = await t.core.startChat({ text: 'hi', backendId: 'mock' })
      await until(() => t.store.conversation(conv.id)?.status === 'idle' && t.store.messagesOf(conv.id).some((m) => m.role === 'assistant' && m.state === 'done'))
      // The first message used the spare: one prompt, and no session/new before it.
      expect(count('session/prompt')).toBe(1)
      // The next new chat's spare is opened once the reply is in, and no hidden prompt (a title) follows.
      await opened(t.core, t.store.conversation(conv.id)?.sessionRef?.sessionId)
      await new Promise((r) => setTimeout(r, 500))
      expect(count('session/new')).toBe(2)
      expect(count('session/prompt')).toBe(1)
      expect(t.store.conversation(conv.id)?.title).toBe('Hi')
    } finally {
      await t.dispose()
    }
  }, 30000)

  it('is the one a new chat gets, with its id, and the next one is opened after', async () => {
    const t = await makeCore(undefined, {}, {}, [slowSessions])
    try {
      await t.core.warmBackend('mock', '')
      const spare = await opened(t.core)
      const conv = await t.core.startChat({ text: 'hi', backendId: 'mock' })
      expect(conv.id).toBe(spare.id)
      await until(() => t.store.conversation(conv.id)?.status === 'idle' && t.store.messagesOf(conv.id).some((m) => m.role === 'assistant'))
      expect(t.store.conversation(conv.id)?.sessionRef?.sessionId).toBe(spare.sessionId)
      const next = await opened(t.core)
      expect(next.id).not.toBe(spare.id)
      expect(next.sessionId).not.toBe(spare.sessionId)
    } finally {
      await t.dispose()
    }
  })

  it('is not used by a chat in another folder', async () => {
    const t = await makeCore(undefined, {}, {}, [slowSessions])
    try {
      await t.core.warmBackend('mock', '')
      const spare = await opened(t.core)
      const folder = mkdtempSync(join(tmpdir(), 'oc-spare-'))
      const conv = await t.core.startChat({ text: 'hi', backendId: 'mock', cwd: folder })
      expect(conv.id).not.toBe(spare.id)
      await until(() => t.store.conversation(conv.id)?.status === 'idle' && t.store.messagesOf(conv.id).some((m) => m.role === 'assistant'))
      expect(t.store.conversation(conv.id)?.sessionRef?.sessionId).not.toBe(spare.sessionId)
    } finally {
      await t.dispose()
    }
  })

  it('opens on the model picked for new chats: the agent starts again with it before any chat is open', async () => {
    const t = await makeCore(undefined, {}, {}, [slowSessions])
    try {
      await t.core.warmBackend('mock', '')
      const first = await opened(t.core)
      expect((await first.info)?.currentModelId).toBe('mock-fast')
      await t.core.setModelDefault('mock', 'mock-smart')
      const next = await opened(t.core, first.sessionId)
      expect((await next.info)?.currentModelId).toBe('mock-smart')
      const conv = await t.core.startChat({ text: 'hi', backendId: 'mock' })
      expect(conv.id).toBe(next.id)
      expect(conv.modelId).toBe('mock-smart')
      await until(() => t.store.conversation(conv.id)?.status === 'idle' && t.store.messagesOf(conv.id).some((m) => m.role === 'assistant'))
    } finally {
      await t.dispose()
    }
  })
})
