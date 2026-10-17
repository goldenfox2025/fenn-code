import { describe, expect, it } from 'vitest'
import { resolveModelAliases, resolveOptionAliases } from '../src/shared/aliases'
import { makeCore, until } from './helpers'

const opus = { id: 'opus', name: 'Opus 5.5' }
const sonnet = { id: 'sonnet', name: 'Sonnet 5.5' }

describe('stand-in models and levels', () => {
  it('shows the model a "Default (recommended)" stands for, or leaves it out', () => {
    const def = { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Most capable for complex work' }
    expect(resolveModelAliases([def, opus, sonnet], 'default')).toEqual({ models: [opus, sonnet], current: 'opus' })
    expect(resolveModelAliases([def, opus, sonnet], 'sonnet')).toEqual({ models: [opus, sonnet], current: 'sonnet' })
    const vague = { id: 'auto', name: 'Auto', description: 'Picks for you' }
    expect(resolveModelAliases([vague, opus], 'opus').models).toEqual([opus])
    // The current one can't be named: it stays, rather than showing a wrong model.
    expect(resolveModelAliases([vague, opus], 'auto')).toEqual({ models: [vague, opus], current: 'auto' })
    // Only stand-ins: kept.
    expect(resolveModelAliases([vague], 'auto').models).toEqual([vague])
    // Real models that merely start with Auto or carry a "(recommended)" tag stay, the tag left off.
    const autoG = { id: 'auto-gemini', name: 'Auto Gemini' }
    const tagged = { id: 'gpt-x', name: 'GPT X (recommended)' }
    expect(resolveModelAliases([autoG, tagged, opus], 'opus').models).toEqual([autoG, { ...tagged, name: 'GPT X' }, opus])
  })

  it('drops a "Default" thinking level and moves the session to the recommended one', () => {
    const effort = { id: 'effort', name: 'Effort', category: 'thought_level', current: 'default',
      choices: [{ value: 'default', name: 'Default' }, { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }
    const mode = { id: 'mode', name: 'Mode', category: 'mode', current: 'default', choices: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] }
    const r = resolveOptionAliases([mode, effort])
    expect(r.options[0]).toBe(mode)
    expect(r.options[1]).toMatchObject({ current: 'medium', choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] })
    expect(r.fixes).toEqual([{ id: 'effort', value: 'medium' }])
    expect(resolveOptionAliases([{ ...effort, current: 'high' }]).fixes).toEqual([])
  })

  it('a Claude Code–style agent: the chip names the real model and level, and the agent gets that level', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_ALIASES: '1' })
    try {
      const c = await core.startChat({ backendId: 'mock', text: 'hi' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      const conv = store.conversation(c.id)!
      expect(conv.models?.map((m) => m.id)).toEqual(['mock-fast', 'mock-smart'])
      expect(conv.modelId).toBe('mock-smart')
      const effort = conv.sessionOptions?.find((o) => o.id === 'effort')
      expect(effort?.choices.map((x) => x.value)).toEqual(['low', 'medium', 'high'])
      expect(effort?.current).toBe('medium')
    } finally { await dispose() }
  })
})
