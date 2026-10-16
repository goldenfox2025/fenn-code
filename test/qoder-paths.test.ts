import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { qoderCommand } from '../src/main/backends/qoderCommand'
import qoder, { qoderAccount } from '../src/main/backends/plugins/qoder'
import { runAccountCheck } from '../src/main/backends/acp'
import { BackendManager } from '../src/main/backends/BackendManager'
import type { HostEvent } from '../src/shared/contract'

const temporary: string[] = []
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'ancora qoder paths '))
  temporary.push(dir)
  return dir
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Qoder runtime selection', () => {
  it('keeps executable launchers and the uninstalled fallback usable', () => {
    vi.stubEnv('PATH', temp())
    expect(qoderCommand({}, ['--acp'])).toEqual({ command: 'qodercli', args: ['--acp'] })
    const launcher = join(temp(), 'qoder cli.exe')
    writeFileSync(launcher, '')
    expect(qoderCommand({ QODER_CLI_PATH: launcher }, ['login'])).toEqual({ command: launcher, args: ['login'] })
  })

  it('detects a missing JS entry even when the Node executable exists', () => {
    expect(qoder.isInstalled?.({ QODER_NODE_PATH: process.execPath, QODER_CLI_PATH: join(temp(), 'missing.js') })).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('resolves an npm symlink and uses Node beside its launcher instead of another PATH runtime', () => {
    const root = temp()
    const bin = join(root, 'node installation', 'bin')
    const otherBin = join(root, 'another-node', 'bin')
    const entry = join(root, 'node installation', 'lib', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js')
    mkdirSync(dirname(entry), { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(otherBin, { recursive: true })
    writeFileSync(entry, '')
    symlinkSync(entry, join(bin, 'qodercli'))
    symlinkSync(process.execPath, join(bin, 'node'))
    writeFileSync(join(otherBin, 'node'), '')
    chmodSync(join(otherBin, 'node'), 0o755)
    vi.stubEnv('PATH', `${otherBin}:${bin}`)
    const spec = qoderCommand({}, ['--acp'])
    expect(spec.command).toBe(realpathSync(process.execPath))
    expect(spec.args).toEqual([realpathSync(entry), '--acp'])
    expect(qoder.isInstalled?.({})).toBe(true)
  })

  it('uses the configured Node and JS paths for sign-in, status, model discovery and a complete ACP reply', async () => {
    const dir = temp()
    const entry = join(dir, 'qoder entry.mjs')
    const mock = pathToFileURL(join(__dirname, '../resources/mock-agent.mjs')).href
    writeFileSync(entry, `
      if (process.argv[2] === 'status') {
        console.log(JSON.stringify({ logged_in: process.env.QODER_PERSONAL_ACCESS_TOKEN === 'test-only-token', version: 'test-fixture' }))
      } else if (process.argv[2] === '--acp') {
        await import(${JSON.stringify(mock)})
      } else process.exit(2)
    `)
    const config = { QODER_NODE_PATH: process.execPath, QODER_CLI_PATH: entry, QODER_PERSONAL_ACCESS_TOKEN: 'test-only-token' }
    expect(qoder.isInstalled?.(config)).toBe(true)
    expect(qoder.isInstalled?.({ ...config, QODER_NODE_PATH: join(dir, 'missing-node') })).toBe(false)
    expect(await runAccountCheck(qoderAccount(config))).toMatchObject({ installed: true, signedIn: true, version: 'test-fixture' })
    const events: HostEvent[] = []
    const manager = new BackendManager({ plugins: [qoder], settings: { get: () => config, set: () => {} },
      resourcesDir: join(__dirname, '../resources'), nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: dir, emit: (e) => events.push(e) })
    try {
      expect(manager.loginCommand('qoder')).toEqual({ command: realpathSync(process.execPath), args: [realpathSync(entry), 'login'] })
      const session = await manager.newSession('qoder')
      expect(session.models?.map((model) => model.id)).toContain('mock-fast')
      const result = await manager.prompt('qoder', session.sessionId, [{ type: 'text', text: 'hello path test' }])
      expect(result.stopReason).toBe('end_turn')
      expect(events.some((event) => event.type === 'agent' && event.event.kind === 'message.delta' && event.event.text)).toBe(true)
    } finally { await manager.disposeAll() }
  })
})
