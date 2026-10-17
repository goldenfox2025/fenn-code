import { expect, it } from 'vitest'
import { makeCore, until } from './helpers'

// What a thread's agent reads besides its task: its notes and the app's tools.
// The user asked for working threads to carry as little prompt as possible; this cap only goes down.
const THREAD_CAP = 4800

it('a thread starts with a short prompt and only the tools its task needs', async () => {
  const { core, store, dispose } = await makeCore()
  try {
    const p = await core.createProject({ name: '定价', backendId: 'mock' })
    const o = (core as any).orchestrator
    const th = o.startThread(p, '竞品定价调研', '用户原话：调研竞品定价')
    await until(() => store.conversation(th.id)?.status !== 'working', 20000)
    const pre: string = o.preamble(store.conversation(th.id), false)
    const tools = o.toolsFor(th.id) as { name: string; description: string; inputSchema: unknown }[]
    const toolChars = tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length, 0)
    expect(pre.length + toolChars).toBeLessThanOrEqual(THREAD_CAP)
    for (const name of ['progress_update', 'create_routine', 'set_title', 'react']) expect(tools.map((t) => t.name)).not.toContain(name)
  } finally { await dispose() }
}, 60000)
