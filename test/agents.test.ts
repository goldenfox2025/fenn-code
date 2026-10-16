import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeAccount } from '../src/main/backends/plugins/claude-code'
import { codexAccount } from '../src/main/backends/plugins/codex'
import { findOnPath } from '../src/main/backends/install'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import { join } from 'node:path'

describe('Claude Code and Codex plugins', () => {
  it('read the sign-in state each CLI prints', () => {
    const c = claudeAccount()
    expect(c.requires).toEqual(['claude-agent-acp'])
    expect(c.parse('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max"}')).toEqual({ installed: true, signedIn: true, detail: 'Claude 账号 · max' })
    expect(c.parse('{"loggedIn": false}')).toMatchObject({ signedIn: false })
    const x = codexAccount()
    expect(x.stderr).toBe(true)
    expect(x.parse('\nLogged in using ChatGPT\n')).toEqual({ installed: true, signedIn: true, detail: 'ChatGPT 账号' })
    expect(x.parse('WARNING: proceeding\nNot logged in\n')).toEqual({ installed: true, signedIn: false })
  })

  it('install both the CLI and its ACP adapter, and say so before running', () => {
    const plugins = loadPlugins()
    const claude = plugins.find((p) => p.id === 'claude-code')!
    const codex = plugins.find((p) => p.id === 'codex')!
    expect(claude.upgrade?.run.args).toEqual(['install', '-g', '@anthropic-ai/claude-code@latest', '@agentclientprotocol/claude-agent-acp@latest'])
    expect(claude.upgrade?.after?.labelArgs).toContain('install.cjs')
    expect(codex.upgrade?.run.args).toEqual(['install', '-g', '@openai/codex@latest', '@agentclientprotocol/codex-acp@latest'])
    // The confirmation lists every command, the follow-up setup step included.
    const mgr = new BackendManager({ plugins, settings: { get: () => ({}), set: () => {} }, resourcesDir: '.', nodeCommand: { command: 'node', env: {} }, defaultCwd: '.', emit: () => {} })
    const shown = mgr.list().find((b) => b.id === 'claude-code')!.upgradeCommands!
    expect(shown[0]).toBe('npm install -g @anthropic-ai/claude-code@latest @agentclientprotocol/claude-agent-acp@latest')
    expect(shown[1]).toMatch(/^node -e '[\s\S]*install\.cjs[\s\S]*'$/)
  })

  // Runs where the adapters are installed (e.g. ADAPTERS_BIN=…/node_modules/.bin): handshake only, no prompt.
  const bin = process.env.ADAPTERS_BIN
  it.runIf(bin)('start a session through the real adapters, or say to sign in', async () => {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
    expect(findOnPath('claude-agent-acp')).toBeTruthy()
    const mgr = new BackendManager({
      plugins: loadPlugins(),
      settings: { get: () => ({}), set: () => {} },
      resourcesDir: join(__dirname, '../resources'),
      nodeCommand: { command: process.execPath, env: {} },
      defaultCwd: process.cwd(),
      emit: () => {}
    })
    try {
      // Codex here has no login: the handshake works and the error names the 登录 button.
      await expect(mgr.newSession('codex')).rejects.toThrow('Codex 里点「登录」')
      expect(mgr.acceptsImages('codex')).toBe(true)
      // Claude Code's adapter opens a session (no prompt is sent) and offers its modes.
      const s = await mgr.newSession('claude-code')
      expect(s.options?.find((o) => o.category === 'mode')?.choices?.map((c) => c.value)).toContain('plan')
      expect(mgr.acceptsImages('claude-code')).toBe(true)
    } finally {
      await mgr.disposeAll()
    }
  }, 120_000)
})
