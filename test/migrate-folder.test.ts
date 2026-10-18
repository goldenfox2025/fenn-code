import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inUse, moveAppData } from '../src/main/store/migrateFolder'

function old() {
  const base = mkdtempSync(join(tmpdir(), 'mig-'))
  const from = join(base, 'Ancora')
  mkdirSync(join(from, 'data'), { recursive: true })
  writeFileSync(join(from, 'data', 'state.json'), '{}')
  writeFileSync(join(from, 'Local State'), '{"os_crypt":{}}')
  mkdirSync(join(from, 'Cache'))
  return { from, to: join(base, 'Fenn Code') }
}

describe('moving the data from the old name', () => {
  it('moves the data with its key, and the rest', () => {
    const { from, to } = old()
    expect(moveAppData(from, to)).toBe(true)
    expect(readFileSync(join(to, 'Local State'), 'utf8')).toContain('os_crypt')
    expect(existsSync(join(to, 'data', 'state.json'))).toBe(true)
    expect(existsSync(join(to, 'Cache'))).toBe(true)
    expect(existsSync(from)).toBe(false)
  })

  it('leaves it all where it is while an old copy runs on it', () => {
    const { from, to } = old()
    symlinkSync(`${hostname()}-${process.pid}`, join(from, 'SingletonLock'))
    expect(inUse(from)).toBe(true)
    expect(moveAppData(from, to)).toBe(false)
    expect(existsSync(join(from, 'data', 'state.json'))).toBe(true)
    expect(existsSync(join(to, 'Local State'))).toBe(false)
  })

  it('on Windows, a lockfile no one holds is stale', () => {
    const { from } = old()
    writeFileSync(join(from, 'lockfile'), '')
    expect(inUse(from, 'win32')).toBe(false)
    expect(existsSync(join(from, 'lockfile'))).toBe(false)
  })
})
