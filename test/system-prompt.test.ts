import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { acpPlugin } from '../src/main/backends/acp'
import { loadPlugins } from '../src/main/backends/registry'
import { makeCore, until } from './helpers'

const lastReply = (store: any, id: string) => {
  const m = store.messagesOf(id).filter((x: any) => x.role === 'assistant').pop()
  return m?.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') ?? ''
}

async function thread(env: Record<string, string>, backendId = 'mock') {
  const made = await makeCore(undefined, env)
  if (backendId !== 'mock')
    await made.core.backends.setPlugins([...loadPlugins(), acpPlugin({ id: backendId, name: 'Rules agent', quirks: { systemPromptMeta: 'rules' },
      launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) })])
  const p = await made.core.createProject({ name: '定价', backendId })
  const th = (made.core as any).orchestrator.startThread(p, '竞品定价调研', '规则在哪')
  const idle = (n: number) => until(() => made.store.conversation(th.id)?.status !== 'working' && made.store.messagesOf(th.id).filter((m: any) => m.role === 'assistant' && m.state === 'done').length >= n, 20000)
  await idle(1)
  return { ...made, id: th.id as string, idle }
}

describe("the app's notes for an agent", () => {
  it('go in as the system prompt when the agent takes one, so compaction keeps them', async () => {
    const { core, store, dispose, id, idle } = await thread({ MOCK_SYSTEM_PROMPT: '1' })
    try {
      expect(lastReply(store, id)).toContain('系统提示：有；本条消息：无')
      await core.send(id, '#压缩 继续')
      await idle(2)
      await core.send(id, '规则在哪')
      await idle(3)
      expect(lastReply(store, id)).toContain('系统提示：有；本条消息：无')
    } finally { await dispose() }
  }, 60000)

  it("go in the agent's own session field when it has one (Grok's _meta.rules)", async () => {
    const { store, dispose, id } = await thread({}, 'rules')
    try {
      expect(lastReply(store, id)).toContain('系统提示：有；本条消息：无')
    } finally { await dispose() }
  }, 60000)

  it("come back too when the agent compacts without saying so: the context it reports halves", async () => {
    const { core, store, dispose, id, idle } = await thread({})
    try {
      await core.send(id, '#大上下文 继续')
      await idle(2)
      await core.send(id, '#静默压缩 继续')
      await idle(3)
      await core.send(id, '规则在哪')
      await idle(4)
      expect(lastReply(store, id)).toContain('本条消息：有')
    } finally { await dispose() }
  }, 60000)

  it('otherwise come first in the next message after the agent compacts', async () => {
    const { core, store, dispose, id, idle } = await thread({})
    try {
      expect(lastReply(store, id)).toContain('系统提示：无；本条消息：有')
      await core.send(id, '规则在哪')
      await idle(2)
      expect(lastReply(store, id)).toContain('本条消息：无')
      await core.send(id, '#压缩 继续')
      await idle(3)
      const step = store.messagesOf(id).filter((m: any) => m.role === 'assistant').pop()!.blocks.find((b: any) => b.type === 'tool')
      expect(step).toMatchObject({ title: '压缩上下文', status: 'completed' })
      await core.send(id, '规则在哪')
      await idle(4)
      expect(lastReply(store, id)).toContain('本条消息：有')
    } finally { await dispose() }
  }, 60000)
})

describe('compacting on request', () => {
  it("runs the agent's own /compact as written, keeps it out of a replay, and hands the notes over next", async () => {
    const { core, store, dispose, id, idle } = await thread({})
    try {
      await until(() => store.conversation(id)?.compactCommand === 'compact')
      await core.compactContext(id)
      await idle(2)
      expect(lastReply(store, id)).toContain('上下文已压缩')
      expect(store.messagesOf(id).filter((m: any) => m.housekeeping).length).toBe(2)
      await core.send(id, '规则在哪')
      await idle(3)
      expect(lastReply(store, id)).toContain('本条消息：有')
    } finally { await dispose() }
  }, 60000)
})
