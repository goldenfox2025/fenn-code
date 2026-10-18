import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import { authHintFor } from '../src/main/backends/acp'
import { terminalLaunch } from '../src/main/backends/terminal'
import { nextRun } from '../src/main/core/schedule'
import { classifyError, isFriendly } from '../src/shared/errors'
import { makeCore } from './helpers'

const agent = join(__dirname, '../resources/mock-agent.mjs')

function manager(plugins = loadPlugins()) {
  return new BackendManager({
    plugins,
    settings: { get: () => ({}), set: () => {} },
    resourcesDir: join(__dirname, '../resources'),
    nodeCommand: { command: process.execPath, env: {} },
    defaultCwd: process.cwd(),
    emit: () => {}
  })
}

describe('reloading backends.json', () => {
  it('keeps unchanged agents running and restarts only the edited one', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'oc-reload-')), 'backends.json')
    const decl = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, command: process.execPath, args: [agent], ...extra })
    writeFileSync(file, JSON.stringify([decl('a'), decl('b')]))
    const mgr = manager(loadPlugins(file))
    const lost: string[] = []
    mgr.onSessionsLost((id) => lost.push(id))
    const sa = await mgr.newSession('a')
    await mgr.newSession('b')
    // A turn on "a" keeps going across a reload that adds a new backend and edits "b".
    const turn = mgr.prompt('a', sa.sessionId, [{ type: 'text', text: 'hi' }])
    writeFileSync(file, JSON.stringify([decl('a'), decl('b', { env: { X: '1' } }), decl('c')]))
    expect(await mgr.setPlugins(loadPlugins(file))).toEqual(['b'])
    expect((await turn).stopReason).toBe('end_turn')
    expect(lost).toEqual(['b'])
    // Removing a backend stops it.
    writeFileSync(file, JSON.stringify([decl('b', { env: { X: '1' } })]))
    expect(await mgr.setPlugins(loadPlugins(file))).toEqual(['a'])
    await mgr.disposeAll()
  }, 30000)

  it('validates the login command', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'oc-login-')), 'backends.json')
    writeFileSync(file, JSON.stringify([{ id: 'q', name: 'Q', command: 'q', login: 'q login' }]))
    expect(() => loadPlugins(file)).toThrow(/"login"/)
    writeFileSync(file, JSON.stringify([{ id: 'q', name: 'Q', command: 'q', login: { command: 'q', args: ['login'] } }]))
    const mgr = manager(loadPlugins(file))
    expect(mgr.list().find((b) => b.id === 'q')!.terminalLogin).toBe(true)
    expect(mgr.loginCommand('q')).toEqual({ command: 'q', args: ['login'] })
  })
})

describe('Qoder', () => {
  it('is built in, with a terminal login and a token passed as QODER_PERSONAL_ACCESS_TOKEN', () => {
    const b = manager().list().find((x) => x.id === 'qoder')!
    expect(b.terminalLogin).toBe(true)
    expect(b.settings.map((s) => s.key)).toEqual(['QODER_CLI_PATH', 'QODER_NODE_PATH', 'QODER_PERSONAL_ACCESS_TOKEN'])
    expect(b.settings.find((s) => s.key === 'QODER_PERSONAL_ACCESS_TOKEN')?.secret).toBe(true)
  })

  it('opens qodercli login through the app shell and forgets stale sessions', async () => {
    const { core, dispose } = await makeCore()
    const opened: string[][] = []
    core.openTerminal = async (c, a) => void opened.push([c, ...a])
    await core.setBackendSetting('qoder', 'QODER_CLI_PATH', 'qoder-login-fixture')
    await core.backendTerminalLogin('qoder')
    expect(opened).toEqual([['qoder-login-fixture', 'login']])
    await expect(core.backendTerminalLogin('mock')).rejects.toThrow(/没有登录命令/)
    await dispose()
  })

  it('names only the sign-in controls a backend has', () => {
    expect(authHintFor({ name: 'Q', login: { command: 'q' }, settings: [{ key: 'K', label: 'Access Token', secret: true }] })).toBe(
      '请在 设置 → Agent 后端 → Q 里点「登录」，或填写「Access Token」，然后重试。'
    )
    expect(authHintFor({ name: 'Q', settings: [{ key: 'K', label: 'Token', secret: true }] })).not.toContain('登录」')
    expect(authHintFor({ name: 'Q' })).toBe('请按 Q 的说明登录后重试。')
  })
})

describe('opening a terminal', () => {
  it('builds a visible window per platform', () => {
    const win = terminalLaunch('qodercli', ['login'], 'win32')!
    expect(win.command).toBe('cmd.exe')
    expect(win.args.at(-1)).toBe('start "" cmd.exe /s /k "qodercli login"')
    const mac = terminalLaunch('qodercli', ['login'], 'darwin')!
    expect(mac.args[1]).toContain('do script "qodercli login"')
    const dir = mkdtempSync(join(tmpdir(), 'oc-term-'))
    writeFileSync(join(dir, 'xterm'), '')
    expect(terminalLaunch('qodercli', ['login'], 'linux', { PATH: dir })!.command).toBe('xterm')
    expect(terminalLaunch('qodercli', ['login'], 'linux', { PATH: '/nonexistent' })).toBeNull()
  })
})

describe('error wording', () => {
  it('recognises common agent failures', () => {
    expect(classifyError('Authentication required: run qodercli login')).toBe('auth')
    expect(classifyError('Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh')).toBe('refresh')
    expect(classifyError('Error: 401 Unauthorized')).toBe('auth')
    expect(classifyError('Invalid API key provided')).toBe('auth')
    expect(classifyError('Internal error: model overloaded (429)')).toBe('rate')
    expect(classifyError('fetch failed: getaddrinfo ENOTFOUND api.x.ai')).toBe('network')
    expect(classifyError('connect ECONNREFUSED 127.0.0.1:3128')).toBe('network')
    expect(classifyError('Request timed out')).toBe('timeout')
    expect(classifyError('insufficient_quota: You exceeded your current quota')).toBe('quota')
    expect(classifyError('502 Bad Gateway')).toBe('server')
    expect(classifyError('403 Forbidden')).toBe('forbidden')
    expect(classifyError('something odd')).toBeNull()
  })
  it('leaves the app’s own Chinese messages alone', () => {
    expect(isFriendly('Qoder 需要登录。请在…')).toBe(true)
    expect(isFriendly('Authentication required')).toBe(false)
  })
})

describe('interval routines', () => {
  const at = (s: string) => new Date(s).getTime()
  it('fire on whole minutes counted from the slot, not from when the run ended', () => {
    const s = { kind: 'interval' as const, minutes: 1 }
    const slot = at('2026-10-13T17:44:00')
    // The run took 25 s; the next one is still at 17:45:00.
    expect(nextRun(s, slot + 25_000, slot + 25_000, slot)).toBe(at('2026-10-13T17:45:00'))
    // A new routine starts on a whole minute.
    expect(nextRun(s, at('2026-10-13T17:44:10'))).toBe(at('2026-10-13T17:46:00'))
    // A run that overran several slots skips them instead of firing back to back.
    expect(nextRun({ kind: 'interval', minutes: 5 }, slot + 12 * 60_000, undefined, slot)).toBe(slot + 15 * 60_000)
  })
})
