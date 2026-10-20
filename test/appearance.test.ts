import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeTheme } from '../src/shared/model'
import { Store } from '../src/main/store/Store'

describe('appearance settings', () => {
  it.each([
    [{ theme: 'glass' }, { theme: 'dark' }],
    [{ theme: 'glass-light' }, { theme: 'light' }],
    [{ theme: 'light', glass: true }, { theme: 'light' }],
    [{ theme: 'dark', glass: false }, { theme: 'dark' }],
    [{ theme: 'system', glass: true }, { theme: 'system' }],
    [{ theme: 'unknown' }, { theme: 'system' }]
  ])('migrates retired appearance settings %j', (input, expected) => {
    expect(normalizeTheme(input)).toEqual(expected)
  })

  it('persists the migration without losing other saved settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fenn-theme-migration-'))
    let store: Store | undefined
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({
        version: 1, settings: { theme: 'glass', glass: true, userName: 'Fox', dotGrid: 2 }
      }))
      store = new Store(dir)
      expect(store.settings).toMatchObject({ theme: 'dark', userName: 'Fox', dotGrid: 2 })
      expect(store.settings).not.toHaveProperty('glass')
      store.flush()
      const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings
      expect(saved.theme).toBe('dark')
      expect(saved).not.toHaveProperty('glass')
    } finally {
      store?.flush()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
