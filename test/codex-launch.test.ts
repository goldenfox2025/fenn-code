import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexLaunch } from '../src/main/backends/plugins/codex'

const TRIPLE: Record<string, string> = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc' }

describe('starting Codex', () => {
  it('runs codex-acp as node <script> past the npm shim, and Codex itself directly', () => {
    // A global npm install as on Windows: npm/codex-acp.cmd beside npm/node_modules.
    const npm = mkdtempSync(join(tmpdir(), 'fenn-code-npm-'))
    const pkg = (dir: string, name: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    }
    const adapter = join(npm, 'node_modules/@agentclientprotocol/codex-acp')
    pkg(adapter, '@agentclientprotocol/codex-acp')
    mkdirSync(join(adapter, 'dist'))
    writeFileSync(join(adapter, 'dist/index.js'), '')
    const codex = join(adapter, 'node_modules/@openai/codex')
    pkg(codex, '@openai/codex')
    const vendor = join(adapter, `node_modules/@openai/codex-${process.platform}-${process.arch}`)
    pkg(vendor, `@openai/codex-${process.platform}-${process.arch}`)
    const bin = join(vendor, 'vendor', TRIPLE[`${process.platform}-${process.arch}`], 'bin')
    mkdirSync(bin, { recursive: true })
    const exe = join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex')
    writeFileSync(exe, '')
    writeFileSync(join(npm, 'codex-acp.cmd'), '@node "%~dp0\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js" %*')

    const spec = codexLaunch({ CODEX_ACP_PATH: join(npm, 'codex-acp.cmd') })
    expect(spec.args).toEqual([join(adapter, 'dist/index.js')])
    expect(spec.command).toMatch(/node(\.exe)?$/)
    expect(spec.env.CODEX_PATH).toBe(exe)
    expect(spec.env.CODEX_MANAGED_PACKAGE_ROOT).toBe(codex)
    // A Codex the user named wins.
    expect(codexLaunch({ CODEX_ACP_PATH: join(npm, 'codex-acp.cmd'), CODEX_CLI_PATH: '/opt/codex' }).env).toEqual({ CODEX_PATH: '/opt/codex' })
  })
})
