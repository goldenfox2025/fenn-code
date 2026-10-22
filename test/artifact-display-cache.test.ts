import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Artifacts } from '../src/main/core/Artifacts'

const roots: string[] = []
function artifacts() {
  const root = mkdtempSync(join(tmpdir(), 'fenn-artifact-cache-'))
  roots.push(root)
  return new Artifacts(root)
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('prepared artifact display documents', () => {
  it('reads and prepares a saved version once while keeping source export intact', () => {
    const store = artifacts()
    const source = '<!doctype html><h1>Saved UI</h1>'
    const { meta } = store.publish('chat', 'UI', source)
    const read = vi.spyOn(store, 'html')
    const first = store.displayHtml(meta.id, 1)
    expect(first).toContain('data-fenn-ui-picker-events')
    expect(store.displayHtml(meta.id, 1)).toBe(first)
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.html(meta.id, 1)).toBe(source)
  })

  it('resolves latest versions anew and never caches missing versions', () => {
    const store = artifacts()
    const { meta } = store.publish('chat', 'UI', '<h1>First</h1>')
    expect(store.displayHtml(meta.id)).toContain('First')
    expect(store.displayHtml(meta.id, 2)).toBeUndefined()
    store.publish('chat', 'UI', '<h1>Second</h1>', meta.id)
    expect(store.displayHtml(meta.id)).toContain('Second')
    expect(store.displayHtml(meta.id, 2)).toContain('Second')
    expect(store.displayHtml(meta.id, 1)).toContain('First')
  })

  it('evicts the least recently used documents instead of retaining every page', () => {
    const store = artifacts()
    const ids = Array.from({ length: 17 }, (_, i) => store.publish('chat', `UI ${i}`, `<h1>${i}</h1>`).meta.id)
    for (const id of ids.slice(0, 16)) store.displayHtml(id, 1)
    store.displayHtml(ids[0], 1)
    store.displayHtml(ids[16], 1)
    const read = vi.spyOn(store, 'html')
    store.displayHtml(ids[0], 1)
    expect(read).not.toHaveBeenCalled()
    store.displayHtml(ids[1], 1)
    expect(read).toHaveBeenCalledOnce()
  })

  it('also bounds retained bytes when only a few large pages were opened', () => {
    const store = artifacts()
    const ids = Array.from({ length: 5 }, (_, i) => store.publish('chat', `Large ${i}`, 'a'.repeat(1_900_000)).meta.id)
    for (const id of ids) store.displayHtml(id, 1)
    const read = vi.spyOn(store, 'html')
    store.displayHtml(ids[4], 1)
    expect(read).not.toHaveBeenCalled()
    store.displayHtml(ids[0], 1)
    expect(read).toHaveBeenCalledOnce()
  })
})
