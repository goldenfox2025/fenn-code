import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'

describe('agents that only take stdio MCP servers', () => {
  it('still get the app tools, through the bridge', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_STDIO_MCP: '1' })
    const p = await core.createProject({ name: 'bridge', backendId: 'mock' })
    await core.chat.send(p.conversationId, '帮我调研一下桥接')
    const thread = await until(() => store.conversations.find((c) => c.kind === 'thread' && c.projectId === p.id))
    expect(thread.title).toContain('调研')
    await until(() => store.conversation(thread.id)!.checklist?.includes('✓'), 20000)
    await dispose()
  }, 40000)
})
