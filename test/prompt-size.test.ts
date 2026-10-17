import { expect, it } from 'vitest'
import { makeCore, until } from './helpers'

// What a thread's agent reads besides its task: its notes and the app's tools.
// The user asked for working threads to carry as little prompt as possible; this cap only goes down.
// Measured over the real tools/list JSON: ~9600 before computer control's tools were held back, 5158 after.
const THREAD_CAP = 5200

// What the agent really gets: the app's tools/list over MCP, with every source wired (computer control too).
async function toolsList(core: any, id: string): Promise<{ chars: number; names: string[] }> {
  const { url } = core.orchestrator.tools.endpoint(id, () => core.orchestrator.toolsFor(id))
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  const tools = ((await res.json()) as any).result.tools as { name: string }[]
  return { chars: JSON.stringify(tools).length, names: tools.map((t) => t.name) }
}

it('a thread starts with a short prompt and only the tools its task needs', async () => {
  const { core, store, dispose } = await makeCore(undefined, {}, { computer: { screen: {} as never, input: {} as never, clipboard: {} as never } })
  try {
    const p = await core.createProject({ name: '定价', backendId: 'mock' })
    const o = (core as any).orchestrator
    const th = o.startThread(p, '竞品定价调研', '用户原话：调研竞品定价')
    await until(() => store.conversation(th.id)?.status !== 'working', 20000)
    const pre: string = o.preamble(store.conversation(th.id), false)
    const list = await toolsList(core, th.id)
    expect(pre.length + list.chars).toBeLessThanOrEqual(THREAD_CAP)
    for (const name of ['progress_update', 'create_routine', 'set_title', 'react']) expect(list.names).not.toContain(name)
    // Computer control's tools come only once the user turns it on.
    expect(list.names.some((n) => n.startsWith('computer_'))).toBe(false)
    await core.updateSettings({ computerUse: true })
    expect((await toolsList(core, th.id)).names).toContain('computer_screenshot')
  } finally { await dispose() }
}, 60000)
