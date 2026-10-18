import { describe, expect, it } from 'vitest'
import type { AgentBackend, BackendPlugin, SessionInfo } from '../src/shared/contract'
import { BackendManager } from '../src/main/backends/BackendManager'

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
