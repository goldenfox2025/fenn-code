import { describe, expect, it } from 'vitest'
import { makeCore } from './helpers'

describe('what the core refuses', () => {
  it('a project’s own chat is not deleted on its own (the project would no longer open); deleting the project still works', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: '装修', backendId: 'mock' })
      await expect(core.deleteConversation(p.conversationId)).rejects.toThrow('项目的主对话')
      expect(store.conversation(p.conversationId)).toBeTruthy()
      await core.deleteProject(p.id)
      expect(store.conversation(p.conversationId)).toBeUndefined()
      expect(store.project(p.id)).toBeUndefined()
    } finally {
      await dispose()
    }
  })

  it('a routine without a name, prompt or valid schedule; one with no target gets an empty one', async () => {
    const { core, dispose } = await makeCore()
    try {
      const ok = { name: 'x', prompt: 'y', schedule: { kind: 'interval' as const, minutes: 30 }, enabled: true }
      await expect(core.saveRoutine({ ...ok, name: '' } as any)).rejects.toThrow('不完整')
      await expect(core.saveRoutine({ ...ok, schedule: { kind: 'daily', time: 'soon' } } as any)).rejects.toThrow('不完整')
      await expect(core.saveRoutine({ ...ok, schedule: undefined } as any)).rejects.toThrow('不完整')
      const r = await core.saveRoutine(ok as any)
      expect(r.target).toEqual({})
      // Switching it off sends only what changes on top of the saved routine.
      expect((await core.saveRoutine({ ...r, enabled: false })).enabled).toBe(false)
    } finally {
      await dispose()
    }
  })
})

describe('a project’s folder', () => {
  it('can’t be changed to the home folder', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'x', backendId: 'mock' })
      const before = store.project(p.id)?.cwd
      await expect(core.updateProject(p.id, { cwd: (await import('node:os')).homedir() })).rejects.toThrow()
      expect(store.project(p.id)?.cwd).toBe(before)
    } finally {
      await dispose()
    }
  })
})
