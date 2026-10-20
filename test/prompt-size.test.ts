import { expect, it } from 'vitest'
import { makeCore, until } from './helpers'

// What a thread's agent reads besides its task: its notes and the app's tools.
// The user asked for working threads to carry as little prompt as possible; this cap only goes down.
// Measured over the real tools/list JSON: ~9600 before computer control's tools were held back, 5158 after.
const THREAD_CAP = 5200
// Inline UI and typed charts add their own schemas; keep this explicit rather
// than silently growing the core thread budget for each new capability.
const VISUAL_CAP = 1500

// What the agent really gets: the app's tools/list over MCP, with every source wired (computer control too).
async function toolsList(core: any, id: string): Promise<{ json: string; names: string[] }> {
  const { url } = core.orchestrator.tools.endpoint(id, () => core.orchestrator.toolsFor(id))
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  const tools = ((await res.json()) as any).result.tools as { name: string }[]
  return { json: JSON.stringify(tools), names: tools.map((t) => t.name) }
}

it('a thread starts with a short prompt and only the tools its task needs', async () => {
  const { core, store, dispose } = await makeCore(undefined, {}, { computer: { screen: {} as never, input: {} as never, clipboard: {} as never } })
  try {
    const p = await core.createProject({ name: '定价', backendId: 'mock' })
    const o = (core as any).orchestrator
    const th = o.startThread(p, '竞品定价调研', '用户原话：调研竞品定价')
    await until(() => store.conversation(th.id)?.status !== 'working', 20000)
    // The folder paths in it are as long as the machine makes them (macOS's temp folder is long): counted as one short name.
    const short = (s: string) => s.split(p.cwd ?? '<none>').join('<cwd>').split(store.dir).join('<dir>')
    const pre: string = o.preamble(store.conversation(th.id), false)
    const list = await toolsList(core, th.id)
    const toolDefs = JSON.parse(list.json) as { name: string }[]
    const visual = (t: { name: string }) => ['render_ui', 'render_chart'].includes(t.name)
    expect(short(pre).length + short(JSON.stringify(toolDefs.filter((t) => !visual(t)))).length).toBeLessThanOrEqual(THREAD_CAP)
    expect(JSON.stringify(toolDefs.filter(visual)).length).toBeLessThanOrEqual(VISUAL_CAP)
    for (const name of ['progress_update', 'create_routine', 'set_title', 'react']) expect(list.names).not.toContain(name)
    // Computer control's tools come only once the user turns it on.
    expect(list.names.some((n) => n.startsWith('computer_'))).toBe(false)
    await core.updateSettings({ computerUse: true })
    expect((await toolsList(core, th.id)).names).toContain('computer_screenshot')
  } finally { await dispose() }
}, 60000)
