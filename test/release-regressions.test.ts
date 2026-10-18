import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendPlugin } from '../src/shared/contract'
import { BackendManager } from '../src/main/backends/BackendManager'
import { AppCore } from '../src/main/core/AppCore'
import { Store } from '../src/main/store/Store'
import { ToolServer } from '../src/main/tools/ToolServer'
import { acpPlugin } from '../src/main/backends/acp'
import { classifyError } from '../src/shared/errors'
import { makeCore, until } from './helpers'
import codex, { codexAccount } from '../src/main/backends/plugins/codex'
import { textOf } from '../src/main/core/ChatService'

function startup(availability: Record<string, boolean>, saved = '') {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fenn-code-default-')))
  store.patchSettings({ defaultBackendId: saved })
  const account = vi.fn(async () => ({}))
  const plugins: BackendPlugin[] = Object.entries(availability).map(([id, installed]) => ({
    id, name: id, isInstalled: () => installed, account,
    create: () => { throw new Error('Startup must not launch an agent') }
  }))
  const manager = new BackendManager({ plugins, settings: { get: () => ({}), set: () => {} },
    resourcesDir: '.', nodeCommand: { command: process.execPath, env: {} }, defaultCwd: tmpdir(), emit: () => {} })
  new AppCore(store, manager, () => {}, process.platform, new ToolServer())
  store.flush()
  return { store, account }
}

describe('first-run backend selection', () => {
  it('selects an installed agent without launching an agent', () => {
    const { store } = startup({ codex: false, 'claude-code': false, qoder: true })
    expect(store.settings.defaultBackendId).toBe('qoder')
  })
  it('picks no agent when none is installed, and never one that is missing', () => {
    expect(startup({ custom: false, qoder: false, codex: false }).store.settings.defaultBackendId).toBe('')
  })
  it('preserves a saved choice while it is installed, and moves off one that is not', () => {
    expect(startup({ codex: true, qoder: true }, 'qoder').store.settings.defaultBackendId).toBe('qoder')
    expect(startup({ codex: true, qoder: false }, 'qoder').store.settings.defaultBackendId).toBe('codex')
  })
  it('requires the ACP adapter as well as the CLI', () => {
    const program = join(mkdtempSync(join(tmpdir(), 'fenn-code-program-')), 'agent')
    writeFileSync(program, '')
    const plugin = acpPlugin({ id: 'test', name: 'Test',
      launch: () => ({ command: program, args: [] }),
      account: () => ({ command: program, requires: ['missing-fenn-code-adapter'], parse: () => ({}) }) })
    expect(plugin.isInstalled?.({})).toBe(false)
  })
})

describe('model selection before the first message', () => {
  it('discovers models without creating a chat or generating a token, and uses the chosen model', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const [a, b] = await Promise.all([core.backendModels('mock'), core.backendModels('mock')])
      expect(a).toEqual(b)
      expect(a.models.map((m) => m.id)).toEqual(['mock-fast', 'mock-smart'])
      expect(store.conversations).toHaveLength(0)
      const chat = await core.startChat({ text: '你好', backendId: 'mock', modelId: 'mock-smart' })
      await until(() => store.conversation(chat.id)?.status === 'idle')
      expect(store.conversation(chat.id)?.modelId).toBe('mock-smart')
      expect(await core.backendModels('mock')).toEqual(store.settings.backendModels!.mock)
    } finally { await dispose() }
  })
})

describe('local file denial versus sign-in', () => {
  it('prioritizes EPERM over authentication wording and keeps structured ACP error details', async () => {
    const { core, dispose } = await makeCore(undefined, { MOCK_SESSION_FILE_ERROR: '1' })
    try {
      const error = await core.backendModels('mock').catch((e) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('EPERM')
      expect(error.message).toContain('.qoder/.auth/machine_id')
      expect(error.message).not.toContain('需要登录')
      expect(classifyError(error.message)).toBe('filesystem')
      expect(classifyError('EACCES: permission denied, open /tmp/session.jsonl')).toBe('filesystem')
      expect(classifyError('Authentication required')).toBe('auth')
      expect(classifyError('403 permission denied by API https://api.example.test')).toBe('forbidden')
    } finally { await dispose() }
  })
  it('does not accept an authenticate response as success when the account check is still signed out', async () => {
    const { core, dispose } = await makeCore(undefined, { MOCK_AUTH: '1' })
    try {
      vi.spyOn(core.backends, 'account').mockResolvedValue({ installed: true, signedIn: false, detail: 'login failed: EPERM' })
      await expect(core.backendLogin('mock', 'mock-login')).rejects.toThrow('EPERM')
    } finally { await dispose() }
  })
})

describe('configured Codex programs and live configuration', () => {
  it('uses the configured CLI and adapter for detection and the same CLI for terminal login', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fenn programs '))
    const cli = join(dir, 'Codex CLI')
    const adapter = join(dir, 'Codex ACP')
    writeFileSync(cli, '')
    writeFileSync(adapter, '')
    const config = { CODEX_CLI_PATH: cli, CODEX_ACP_PATH: adapter }
    expect(codexAccount(config)).toMatchObject({ command: cli, requires: [adapter] })
    expect(codex.isInstalled?.(config)).toBe(true)
    expect(codex.isInstalled?.({ ...config, CODEX_ACP_PATH: join(dir, 'missing') })).toBe(false)
    const manager = new BackendManager({ plugins: [codex], settings: { get: () => config, set: () => {} },
      resourcesDir: '.', nodeCommand: { command: process.execPath, env: {} }, defaultCwd: dir, emit: () => {} })
    expect(manager.loginCommand('codex')).toEqual({ command: cli, args: ['login'] })
  })
  it('discards a cached model catalog when that backend configuration changes', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await core.backendModels('mock')
      expect(store.settings.backendModels?.mock).toBeTruthy()
      await core.setBackendSetting('mock', 'example', 'changed')
      expect(store.settings.backendModels?.mock).toBeUndefined()
    } finally { await dispose() }
  })
})

describe('switching an existing conversation to another agent', () => {
  it('keeps history, discards backend-specific state, and replays history to the new session', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const first = await core.startChat({ backendId: 'mock', text: '记住代号 switch-4821' })
      await until(() => store.conversation(first.id)?.status === 'idle')
      const history = store.messagesOf(first.id).map((m) => m.id)
      const plugins = (await import('../src/main/backends/registry')).loadPlugins()
      await core.backends.setPlugins([...plugins, acpPlugin({ id: 'other', name: 'Other',
        launch: () => ({ command: process.execPath, args: [join(__dirname, '../resources/mock-agent.mjs')] }) })])
      await core.updateConversation(first.id, { backendId: 'other' })
      expect(store.conversation(first.id)).toMatchObject({ backendId: 'other', status: 'idle' })
      expect(store.conversation(first.id)?.sessionRef).toBeUndefined()
      expect(store.conversation(first.id)?.modelId).toBeUndefined()
      expect(store.messagesOf(first.id).map((m) => m.id)).toEqual(history)
      await core.send(first.id, '你看到了什么')
      await until(() => store.conversation(first.id)?.status === 'idle')
      expect(textOf(store.messagesOf(first.id).filter((m) => m.role === 'assistant').at(-1)!)).toContain('switch-4821')
      expect(store.conversation(first.id)?.sessionRef?.backendId).toBe('other')
      // A switch no longer has to wait for the reply to end (the reply is stopped first; see backend-preferences).
      await core.updateConversation(first.id, { backendId: 'mock' })
      expect(store.conversation(first.id)).toMatchObject({ backendId: 'mock', status: 'idle' })
    } finally { await dispose() }
  })
})
