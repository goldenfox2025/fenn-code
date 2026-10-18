import { describe, expect, it } from 'vitest'
import type { AgentBackend, BackendPlugin, SessionInfo } from '../src/shared/contract'
import { BackendManager } from '../src/main/backends/BackendManager'
import { acpPlugin } from '../src/main/backends/acp'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * An agent that needs a key (as Grok does): without one, opening a session fails as signed out, a little
 * later. Each process is numbered; `stopped` lists the ones stopped.
 */
function keyedAgent(config: Record<string, string> = {}) {
  const stopped: number[] = []
  let made = 0
  const plugin = {
    id: 'keyed',
    name: 'Keyed',
    create: (host) => {
      const n = ++made
      const key = host.config.KEY
      let s = 0
      const backend = {
        id: 'keyed',
        start: async () => {},
        newSession: async ({ cwd }: { cwd: string }): Promise<SessionInfo> => {
          // The model list read before the key: fails once the agent has looked for a sign-in.
          if (!key || (cwd === 'app' && host.config.PROBE_SIGNED_OUT)) {
            await sleep(300)
            throw new Error('Authentication required')
          }
          await sleep(cwd === 'chat' ? 600 : 10)
          return { sessionId: `p${n}-s${++s}` }
        },
        prompt: async () => ({ stopReason: 'end_turn' }),
        cancel: async () => {},
        dispose: async () => void stopped.push(n)
      }
      return backend as unknown as AgentBackend
    }
  } as BackendPlugin
  const mgr = new BackendManager({
    plugins: [plugin],
    settings: { get: () => ({ ...config }), set: (_id, k, v) => void (config[k] = v) },
    resourcesDir: '.',
    nodeCommand: { command: 'node', env: {} },
    defaultCwd: 'app',
    emit: () => {}
  })
  return { mgr, stopped, made: () => made }
}

describe('a key entered while an earlier model read is still failing as signed out (QA: Grok cut its first reply)', () => {
  it('leaves the restarted agent and the chat opening on it alone', async () => {
    const { mgr, stopped } = keyedAgent()
    const probe = mgr.modelCatalog('keyed').catch((e) => e)
    await sleep(50)
    await mgr.setSetting('keyed', 'KEY', 'xai-1')
    expect(stopped).toEqual([1])
    const chat = mgr.newSession('keyed', { cwd: 'chat' })
    // The old process says signed out while the chat is opening on the new one: no restart under it.
    expect((await probe) instanceof Error).toBe(false)
    expect((await chat).sessionId).toMatch(/^p2-/)
    expect(stopped).toEqual([1])
  })

  it('never restarts the agent while a chat is opening its session on it', async () => {
    const { mgr, stopped } = keyedAgent({ KEY: 'xai-1', PROBE_SIGNED_OUT: '1' })
    const chat = mgr.newSession('keyed', { cwd: 'chat' })
    const probe = mgr.modelCatalog('keyed').catch((e) => e)
    expect(String(await probe)).toContain('Authentication required')
    expect(stopped).toEqual([])
    expect((await chat).sessionId).toMatch(/^p1-/)
  })
})


describe('a model read in flight, then a key, then a reply, all at once (QA: RC29 still cut it, 2 of 40)', () => {
  it('keeps the reply on the new process whole, whatever the old one does after it was replaced', async () => {
    const config: Record<string, string> = {}
    let launches = 0
    const plugin = acpPlugin({
      id: 'keyed-acp',
      name: 'KeyedAcp',
      // Stopping takes a while too (Grok exits about a second after it is told to).
      quirks: { stop: async (proc) => { await sleep(800); proc.kill() } },
      // Starting takes a moment (finding the program); without a key every session/new says signed out.
      launch: async ({ nodeCommand, resourcesDir, config }) => {
        launches++
        await sleep(80)
        return { command: nodeCommand.command, args: [join(resourcesDir, 'mock-agent.mjs')], env: { ...nodeCommand.env, ...(config.KEY ? {} : { MOCK_AUTH: '1' }) } }
      }
    })
    const lost: ((sessionId: string) => boolean)[] = []
    const events: string[] = []
    const mgr = new BackendManager({
      plugins: [plugin],
      settings: { get: () => ({ ...config }), set: (_id, k, v) => void (config[k] = v) },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: (e) => { if (e.type === 'agent' && e.event.kind === 'message.delta') events.push(`${e.sessionId}:${e.event.text}`) }
    })
    mgr.onSessionsLost((_id, isLost) => void lost.push(isLost))
    try {
      // The model list is being read on the first process, which is up by now.
      const probe = mgr.modelCatalog('keyed-acp').catch((e) => e)
      await mgr.warm('keyed-acp')
      // Not waited for, as the app's separate calls aren't: the chat starts while the old process is still stopping.
      const set = mgr.setSetting('keyed-acp', 'KEY', 'xai-1')
      await sleep(30)
      const chat = await mgr.newSession('keyed-acp', { cwd: process.cwd() })
      const reply = mgr.prompt('keyed-acp', chat.sessionId, [{ type: 'text', text: '#啰嗦慢' }])
      await probe
      await set
      const r = await reply
      expect(r.stopReason).toBe('end_turn')
      // The old process went (and said so), but the chat's session on the new one was never among the lost.
      expect(lost.some((isLost) => isLost(chat.sessionId))).toBe(false)
      const text = events.filter((e) => e.startsWith(chat.sessionId + ':')).map((e) => e.slice(chat.sessionId.length + 1)).join('')
      expect(text).toContain('不会另开新的对话')
      // Only the process the key started is used from then on: no third one.
      expect(launches).toBeLessThanOrEqual(2)
    } finally {
      await mgr.disposeAll()
    }
  }, 40000)
})
