import { mkdtempSync } from 'node:fs'
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

describe('a session opened ahead for the next new chat', () => {
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
