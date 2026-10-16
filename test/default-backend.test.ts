import { describe, expect, it } from 'vitest'
import { makeCore } from './helpers'

/** Pretends which agents are installed, whatever this machine has. */
function fakeInstalled(core: any, installed: Record<string, boolean>) {
  const real = core.backends.list.bind(core.backends)
  core.backends.list = () => real().map((b: any) => ({ ...b, installed: installed[b.id] ?? false }))
}

describe('default backend', () => {
  it('moves an old default that is not installed to Codex when Codex is installed', async () => {
    const { core, store, dispose } = await makeCore()
    store.patchSettings({ defaultBackendId: 'qoder' })
    fakeInstalled(core, { codex: true, grok: true, qoder: false })
    core.repairBackends()
    expect(store.settings.defaultBackendId).toBe('codex')
    await dispose()
  })

  it('falls back to the first installed agent, and to none when nothing is installed', async () => {
    const { core, store, dispose } = await makeCore()
    store.patchSettings({ defaultBackendId: 'qoder' })
    fakeInstalled(core, { grok: true })
    core.repairBackends()
    expect(store.settings.defaultBackendId).toBe('grok')
    fakeInstalled(core, {})
    store.patchSettings({ defaultBackendId: 'qoder' })
    core.repairBackends()
    expect(store.settings.defaultBackendId).toBe('')
    await dispose()
  })

  it('keeps a default the user chose while it is installed', async () => {
    const { core, store, dispose } = await makeCore()
    store.patchSettings({ defaultBackendId: 'qoder' })
    fakeInstalled(core, { codex: true, qoder: true })
    core.repairBackends()
    expect(store.settings.defaultBackendId).toBe('qoder')
    await dispose()
  })

  it('never starts new work on an agent that is not installed', async () => {
    const { core, store, dispose } = await makeCore()
    store.patchSettings({ defaultBackendId: 'qoder' })
    fakeInstalled(core, { codex: false, 'claude-code': true, qoder: false })
    expect(core.resolveBackend('qoder')).toBe('claude-code')
    expect(core.resolveBackend()).toBe('claude-code')
    expect(core.resolveBackend('claude-code')).toBe('claude-code')
    // A project on an agent that has since been uninstalled starts its threads elsewhere.
    expect((core.orchestrator as any).pickBackend('qoder')).toBe('claude-code')
    await dispose()
  })

  it('moves an upgraded default, project and routine off an agent that is signed out', async () => {
    const { core, store, dispose } = await makeCore()
    await core.signInRepair
    fakeInstalled(core, { codex: false, 'claude-code': true, qoder: true })
    ;(core as any).backends.account = async (id: string) => ({ signedIn: id === 'claude-code' ? true : id === 'qoder' ? false : undefined })
    const p = await core.createProject({ name: '旧项目', backendId: 'qoder' })
    store.putRoutine({ id: 'r1', name: '早报', prompt: '整理', schedule: { kind: 'daily', time: '09:00' }, target: {}, backendId: 'qoder', enabled: true, createdAt: 0 } as any)
    store.patchSettings({ defaultBackendId: 'qoder' })
    await core.repairSignIns()
    expect(store.settings.defaultBackendId).toBe('claude-code')
    expect(store.project(p.id)!.backendId).toBe('claude-code')
    expect(store.conversation(p.conversationId)!.backendId).toBe('claude-code')
    expect(store.routines.find((r: any) => r.id === 'r1')!.backendId).toBe('claude-code')
    await dispose()
  })

  it('leaves everything alone when the default agent is signed in', async () => {
    const { core, store, dispose } = await makeCore()
    await core.signInRepair
    fakeInstalled(core, { codex: true, qoder: true })
    ;(core as any).backends.account = async () => ({ signedIn: true })
    store.patchSettings({ defaultBackendId: 'qoder' })
    await core.repairSignIns()
    expect(store.settings.defaultBackendId).toBe('qoder')
    await dispose()
  })
})
