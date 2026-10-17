import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeCore, until } from './helpers'
import { join } from 'node:path'
import { acpPlugin } from '../src/main/backends/acp'
import { loadPlugins } from '../src/main/backends/registry'

afterEach(() => vi.restoreAllMocks())

describe('per-agent model and reasoning preferences', () => {
  it('restores reasoning per model, including while switching models in a live chat', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.setModelDefault('mock', 'mock-fast')
      await core.setOptionDefault('mock', 'effort', 'low')
      await core.setModelDefault('mock', 'mock-smart')
      await core.setOptionDefault('mock', 'effort', 'high')
      const c = await core.startChat({ backendId: 'mock', text: 'model-specific effort' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('high')
      await core.setModel(c.id, 'mock-fast')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('low')
      core.chat.patchConversation(c.id, { optionValues: { effort: 'high' } })
      await core.setModel(c.id, 'mock-fast')
      expect(store.conversation(c.id)?.optionValues?.effort).toBe('low')
      await core.setModel(c.id, 'mock-smart')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('high')
      expect(store.settings.backendModelOptionDefaults?.mock).toMatchObject({ 'mock-fast': { effort: 'low' }, 'mock-smart': { effort: 'high' } })
    } finally { await dispose() }
  })

  it('selects model and reasoning on a cold backend in an existing chat without prompting or losing history', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const c = await core.startChat({ backendId: 'mock', text: 'keep cold-switch history' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      const history = store.messagesOf(c.id).map((m) => m.id)
      await core.backends.setPlugins([...loadPlugins(), acpPlugin({ id: 'cold', name: 'Cold agent',
        launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')], env: { MOCK_DYNAMIC_EFFORT: '1' } }) })])
      await core.updateConversation(c.id, { backendId: 'cold' })
      const prompt = vi.spyOn(core.backends, 'prompt')
      const catalog = vi.spyOn(core.backends, 'modelCatalog')
      const first = core.backendModels('cold')
      expect(core.backendModels('cold')).toBe(first)
      await first
      expect(catalog).toHaveBeenCalledTimes(1)
      await core.backendModels('cold')
      expect(catalog).toHaveBeenCalledTimes(1)
      await core.setOptionDefault('cold', 'effort', 'high')
      await core.setModel(c.id, 'mock-smart')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('high')
      await core.setOption(c.id, 'effort', 'low')
      expect(store.conversation(c.id)).toMatchObject({ modelId: 'mock-smart', optionValues: { effort: 'low' } })
      expect(store.conversation(c.id)?.sessionRef).toBeUndefined()
      expect(store.messagesOf(c.id).map((m) => m.id)).toEqual(history)
      expect(prompt).not.toHaveBeenCalled()
      await core.send(c.id, 'continue')
      await until(() => store.conversation(c.id)?.status === 'idle')
      expect(prompt).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(prompt.mock.calls[0][2])).toContain('keep cold-switch history')
      expect(store.conversation(c.id)?.modelId).toBe('mock-smart')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('low')
    } finally { await dispose() }
  })

  it('keeps each backend independent when switching an existing chat away and back', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.backends.setPlugins([...loadPlugins(), acpPlugin({ id: 'other-demo', name: 'Other demo',
        launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) })])
      await core.setModelDefault('mock', 'mock-smart')
      await core.setOptionDefault('mock', 'effort', 'high')
      await core.setModelDefault('other-demo', 'mock-fast')
      await core.setOptionDefault('other-demo', 'effort', 'low')
      const c = await core.startChat({ backendId: 'mock', text: 'first backend' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      await core.updateConversation(c.id, { backendId: 'other-demo' })
      expect(store.conversation(c.id)?.modelId).toBe('mock-fast')
      await core.send(c.id, 'other backend')
      await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= 2)
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('low')
      await core.updateConversation(c.id, { backendId: 'mock' })
      expect(store.conversation(c.id)?.modelId).toBe('mock-smart')
      await core.send(c.id, 'back to first backend')
      await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= 3)
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('high')
      expect(store.settings.backendOptionDefaults?.['other-demo']?.effort).toBe('low')
    } finally { await dispose() }
  })

  it('remembers choices before a message, restores them for new chats and after restarting', async () => {
    const first = await makeCore()
    try {
      await first.core.setModelDefault('mock', 'mock-smart')
      await first.core.setOptionDefault('mock', 'effort', 'high')
      expect(first.store.conversations).toHaveLength(0)
      expect((await first.core.backendModels('mock')).current).toBe('mock-smart')
      const c = await first.core.startChat({ backendId: 'mock', text: 'hello preferences' })
      await until(() => first.store.conversation(c.id)?.status === 'idle')
      expect(first.store.conversation(c.id)?.modelId).toBe('mock-smart')
      expect(first.store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('high')
    } finally { await first.dispose() }
    const restored = await makeCore(first.dir)
    try {
      expect(restored.store.settings.backendModelDefaults?.mock).toBe('mock-smart')
      const c = await restored.core.startChat({ backendId: 'mock', text: 'hello restored' })
      await until(() => restored.store.conversation(c.id)?.status === 'idle')
      expect(restored.store.conversation(c.id)?.modelId).toBe('mock-smart')
      expect(restored.store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('high')
    } finally { await restored.dispose() }
  })

  it('persists accepted live choices and does not remember failed requests or permission modes', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const c = await core.startChat({ backendId: 'mock', text: 'hello' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      await core.setModel(c.id, 'mock-smart')
      await core.setOption(c.id, 'effort', 'high')
      await core.setOption(c.id, 'mode', 'acceptEdits')
      expect(store.settings.backendModelDefaults?.mock).toBe('mock-smart')
      expect(store.settings.backendOptionDefaults?.mock).toEqual({ effort: 'high' })
      vi.spyOn(core.backends, 'setModel').mockRejectedValueOnce(new Error('model refused'))
      await expect(core.setModel(c.id, 'mock-fast')).rejects.toThrow('model refused')
      expect(store.settings.backendModelDefaults?.mock).toBe('mock-smart')
      vi.spyOn(core.backends, 'setOption').mockRejectedValueOnce(new Error('effort refused'))
      await expect(core.setOption(c.id, 'effort', 'low')).rejects.toThrow('effort refused')
      expect(store.settings.backendOptionDefaults?.mock?.effort).toBe('high')
    } finally { await dispose() }
  })

  it('falls back when a remembered model or reasoning level is no longer offered', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      store.patchSettings({ backendModelDefaults: { mock: 'removed-model' }, backendOptionDefaults: { mock: { effort: 'removed-level' } } })
      const c = await core.startChat({ backendId: 'mock', text: 'hello fallback' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      expect(store.conversation(c.id)?.modelId).toBe('mock-fast')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('medium')
    } finally { await dispose() }
  })

  it('refreshes model-dependent reasoning options and hides a singleton none choice', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_DYNAMIC_EFFORT: '1' })
    try {
      expect((await core.backendModels('mock')).options?.some((o) => o.id === 'effort')).toBe(false)
      await core.setModelDefault('mock', 'mock-smart')
      expect((await core.backendModels('mock')).options?.find((o) => o.id === 'effort')?.choices.some((c) => c.value === 'none')).toBe(true)
      const c = await core.startChat({ backendId: 'mock', text: 'hello dynamic options' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      await core.setOption(c.id, 'effort', 'none')
      expect(store.settings.backendOptionDefaults?.mock?.effort).toBe('none')
      await core.setModel(c.id, 'mock-fast')
      expect(store.conversation(c.id)?.sessionOptions?.some((o) => o.id === 'effort')).toBe(false)
      await core.setModel(c.id, 'mock-smart')
      expect(store.conversation(c.id)?.sessionOptions?.find((o) => o.id === 'effort')?.current).toBe('none')
    } finally { await dispose() }
  })
})

describe('switching backend mid-conversation', () => {
  it('drops a session still opening for the old backend, so its model and modes never come back', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.backends.setPlugins([...loadPlugins(), acpPlugin({ id: 'slow', name: 'Slow agent',
        launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')], env: { MOCK_SLOW_START: '600' } }) })])
      await core.setModelDefault('mock', 'mock-fast')
      const c = await core.startChat({ backendId: 'mock', text: 'before the switch' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      await core.updateConversation(c.id, { backendId: 'slow' })
      core.chat.patchConversation(c.id, { modelId: 'mock-smart', optionValues: { mode: 'bypassPermissions' } })
      const setModel = vi.spyOn(core.backends, 'setModel')
      const setOption = vi.spyOn(core.backends, 'setOption')
      await core.prepareConversation(c.id)
      // The user switches again while the slow agent is still starting.
      await core.updateConversation(c.id, { backendId: 'mock' })
      expect(store.conversation(c.id)).toMatchObject({ backendId: 'mock', modelId: 'mock-fast' })
      expect(store.conversation(c.id)?.optionValues).toBeUndefined()
      await new Promise((r) => setTimeout(r, 1500))
      const after = store.conversation(c.id)
      expect(after?.modelId).toBe('mock-fast')
      expect(after?.sessionRef?.backendId).not.toBe('slow')
      expect(after?.sessionOptions?.find((o) => o.category === 'mode')?.current ?? 'default').toBe('default')
      await core.send(c.id, 'after the switch')
      await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= 2)
      expect(store.conversation(c.id)).toMatchObject({ backendId: 'mock', modelId: 'mock-fast', sessionRef: { backendId: 'mock' } })
      expect(setModel.mock.calls.filter((call) => call[0] === 'slow' || call[2] === 'mock-smart')).toEqual([])
      expect(setOption.mock.calls.filter((call) => call[0] === 'slow')).toEqual([])
    } finally { await dispose() }
  })

  it('a model change during a reply waits for the next turn, and the reply keeps going', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.setModelDefault('mock', 'mock-fast')
      const c = await core.startChat({ backendId: 'mock', text: '你好' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      const setModel = vi.spyOn(core.backends, 'setModel')
      void core.send(c.id, '讲一个很长的故事')
      await until(() => store.messagesOf(c.id).some((m) => m.state === 'streaming' && JSON.stringify(m.blocks).length > 200))
      await core.setModel(c.id, 'mock-smart')
      expect(store.conversation(c.id)?.modelId).toBe('mock-smart')
      expect(setModel).not.toHaveBeenCalled()
      await until(() => store.conversation(c.id)?.status === 'idle', 30000)
      expect(store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()?.state).toBe('done')
      await core.send(c.id, '再来一句')
      await until(() => setModel.mock.calls.length > 0)
      expect(setModel.mock.calls.map((call) => call[2])).toEqual(['mock-smart'])
    } finally { await dispose() }
  }, 60000)

  it('a backend picked during a reply waits: the next message stops the reply, keeps what it said, and tells the new agent where it stopped', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.backends.setPlugins([...loadPlugins(), acpPlugin({ id: 'other', name: 'Other agent',
        launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) })])
      const c = await core.startChat({ backendId: 'mock', text: '你好' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      void core.send(c.id, '讲一个很长的故事')
      await until(() => store.messagesOf(c.id).some((m) => m.state === 'streaming' && JSON.stringify(m.blocks).length > 200))
      await core.updateConversation(c.id, { backendId: 'other' })
      // The reply keeps going; the choice waits for the next message.
      expect(store.conversation(c.id)).toMatchObject({ backendId: 'mock', nextBackendId: 'other', status: 'working' })
      expect(store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()?.state).toBe('streaming')
      await core.send(c.id, '你看到了什么')
      const cut = store.messagesOf(c.id).filter((m) => m.role === 'assistant')[1]!
      expect(cut).toMatchObject({ state: 'cancelled', switchedTo: 'Other agent' })
      expect(store.conversation(c.id)?.backendId).toBe('other')
      expect(store.conversation(c.id)?.nextBackendId).toBeUndefined()
      await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).filter((m) => m.role === 'assistant').length >= 3)
      const seen = JSON.stringify(store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()!.blocks)
      expect(seen).toMatch(/(没说完|刚开始)就被中断了/)
    } finally { await dispose() }
  }, 60000)

  it('a backend picked during a reply that then finishes takes over with the next message, nothing cut', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.backends.setPlugins([...loadPlugins(), acpPlugin({ id: 'other', name: 'Other agent',
        launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) })])
      const c = await core.startChat({ backendId: 'mock', text: '你好' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      void core.send(c.id, '讲一个很长的故事')
      await until(() => store.messagesOf(c.id).some((m) => m.state === 'streaming'))
      await core.updateConversation(c.id, { backendId: 'other' })
      await until(() => store.conversation(c.id)?.status === 'idle', 30000)
      expect(store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()?.state).toBe('done')
      expect(store.conversation(c.id)).toMatchObject({ backendId: 'mock', nextBackendId: 'other' })
      // Picking the current one again drops the waiting choice.
      await core.updateConversation(c.id, { backendId: 'mock' })
      expect(store.conversation(c.id)?.nextBackendId).toBeUndefined()
      await core.updateConversation(c.id, { backendId: 'other' })
      expect(store.conversation(c.id)?.backendId).toBe('other')
    } finally { await dispose() }
  }, 60000)

  it('two switches during a reply: the later choice wins', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.backends.setPlugins([...loadPlugins(),
        acpPlugin({ id: 'one', name: 'One', launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) }),
        acpPlugin({ id: 'two', name: 'Two', launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) })])
      const c = await core.startChat({ backendId: 'mock', text: '你好' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      void core.send(c.id, '讲一个很长的故事')
      await until(() => store.messagesOf(c.id).some((m) => m.state === 'streaming'))
      const first = core.updateConversation(c.id, { backendId: 'one' })
      await new Promise((r) => setTimeout(r, 5))
      const second = core.updateConversation(c.id, { backendId: 'two' })
      await Promise.all([first, second])
      expect(store.conversation(c.id)?.nextBackendId).toBe('two')
      await core.send(c.id, '继续')
      expect(store.conversation(c.id)?.backendId).toBe('two')
    } finally { await dispose() }
  }, 60000)
})
