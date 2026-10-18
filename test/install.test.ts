import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../src/main/backends/install'
import { finishNpmInstall } from '../src/main/backends/npmSetup'
import { findGrok } from '../src/main/backends/plugins/grok'
import { loadPlugins } from '../src/main/backends/registry'
import { runAccountCheck } from '../src/main/backends/acp'

describe('finding agent programs, never installing them unasked', () => {
  it("finds Grok's own copy first, then PATH, and nothing otherwise", () => {
    if (process.platform === 'win32') return
    const home = mkdtempSync(join(tmpdir(), 'oc-grokhome-'))
    const binDir = mkdtempSync(join(tmpdir(), 'oc-path-'))
    expect(findGrok({ GROK_HOME: home, PATH: '' })).toBeUndefined()
    writeFileSync(join(binDir, 'grok'), '#!/bin/sh\n')
    chmodSync(join(binDir, 'grok'), 0o755)
    expect(findOnPath('grok', { PATH: binDir })).toBe(join(binDir, 'grok'))
    expect(findGrok({ GROK_HOME: home, PATH: binDir })).toBe(join(binDir, 'grok'))
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, 'bin', 'grok'), '#!/bin/sh\n')
    expect(findGrok({ GROK_HOME: home, PATH: binDir })).toBe(join(home, 'bin', 'grok'))
  })

  it('reports a missing program as not installed', async () => {
    expect(await runAccountCheck({ command: 'definitely-not-installed-xyz', parse: () => ({ installed: true }) })).toEqual({ installed: false })
    expect(await runAccountCheck({ command: process.execPath, args: ['--version'], requires: ['no-such-adapter-xyz'], parse: () => ({ installed: true }) })).toEqual({ installed: false })
  })

  it('every built-in backend installs only through its confirmed Settings command', () => {
    for (const p of loadPlugins().filter((x) => !x.testOnly && x.id !== 'mock')) {
      if (!p.upgrade) continue
      // Antigravity's server isn't on npm: Google's own archive, over https from Google's host only.
      if (p.id === 'antigravity') {
        expect(p.upgrade.run.command).toBe('curl')
        expect(p.upgrade.run.args?.at(-1)).toMatch(/^https:\/\/dl\.google\.com\/agy-extensions\/releases\//)
        expect(p.upgrade.after?.command).toBe(process.platform === 'linux' ? (findOnPath('unzip') || !findOnPath('python3') ? 'unzip' : 'python3') : 'tar')
        continue
      }
      expect(p.upgrade.run.command, p.id).toBe('npm')
      expect(p.upgrade.run.args?.slice(0, 2), p.id).toEqual(['install', '-g'])
    }
  })

  it('finishes an npm install whose own install script was skipped', () => {
    const step = finishNpmInstall('grok', '@xai-official/grok', 'bin/postinstall.js')
    expect(step.command).toBe('node')
    expect(step.args?.[1]).toContain('["@xai-official","grok"]')
    expect(step.labelArgs).toContain('postinstall.js')
  })
})
