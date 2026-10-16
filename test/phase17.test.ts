import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store/Store'

function dataDir(state: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-mig-'))
  mkdirSync(join(dir, 'messages'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, projects: [], conversations: [], routines: [], connectors: [], backendSettings: {}, ...state }))
  return dir
}
const chat = { id: 'c1', kind: 'chat', title: '旧对话', backendId: 'mock', createdAt: 1, updatedAt: 1, status: 'idle' }

describe('upgrading data from before the first-run guide', () => {
  it('marks the guide done when there are chats, projects or a saved name', () => {
    expect(new Store(dataDir({ conversations: [chat], settings: { defaultBackendId: 'mock' } })).settings.onboarded).toBe(true)
    expect(new Store(dataDir({ projects: [{ id: 'p', name: '装修', conversationId: 'c', createdAt: 1, updatedAt: 1 }], settings: {} })).settings.onboarded).toBe(true)
    expect(new Store(dataDir({ settings: { userName: '小林' } })).settings.onboarded).toBe(true)
  })
  it('still guides a fresh install, and one that left the guide half-way', () => {
    expect(new Store(mkdtempSync(join(tmpdir(), 'oc-new-'))).settings.onboarded).toBeFalsy()
    expect(new Store(dataDir({ settings: { defaultBackendId: 'mock' } })).settings.onboarded).toBeFalsy()
    expect(new Store(dataDir({ conversations: [chat], settings: { onboarded: false } })).settings.onboarded).toBe(false)
  })
  it('keeps the choice after saving', () => {
    const dir = dataDir({ conversations: [chat], settings: {} })
    const s = new Store(dir)
    s.flush()
    expect(new Store(dir).settings.onboarded).toBe(true)
  })
})
