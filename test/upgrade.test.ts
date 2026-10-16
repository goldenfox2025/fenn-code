import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BackendManager } from '../src/main/backends/BackendManager'
import { runAccountCheck } from '../src/main/backends/acp'
import { loadPlugins } from '../src/main/backends/registry'
import { addToPath, commandEnv, latestVersion, npmGlobalBin, runStreaming } from '../src/main/backends/upgrade'
import { delimiter } from 'node:path'
import { existsSync } from 'node:fs'
import type { BackendPlugin } from '../src/shared/contract'

const node = (code: string) => ({ command: process.execPath, args: ['-e', code] })

function manager(plugins: BackendPlugin[]) {
  return new BackendManager({
    plugins,
    settings: { get: () => ({}), set: () => {} },
    resourcesDir: join(__dirname, '../resources'),
    nodeCommand: { command: process.execPath, env: {} },
    defaultCwd: process.cwd(),
    emit: () => {}
  })
}

describe('upgrading a backend from the app', () => {
  it('streams the upgrade command’s output and reports whether it worked', async () => {
    const lines: string[] = []
    const ok = await runStreaming(node('console.log("one"); console.error("two"); console.log("three")'), (l) => lines.push(l))
    expect(ok.ok).toBe(true)
    expect(lines).toEqual(expect.arrayContaining(['one', 'two', 'three']))
    const bad = await runStreaming(node('process.exit(3)'), () => {})
    expect(bad.ok).toBe(false)
    const missing = await runStreaming({ command: 'no-such-program-oc' }, () => {})
    expect(missing.ok).toBe(false)
  })

  it('reads the latest version from the command’s output', async () => {
    expect(await latestVersion(node('console.log("1.2.30\\n")'))).toBe('1.2.30')
    expect(await latestVersion(node('process.exit(1)'))).toBeUndefined()
  })

  it('offers 升级 only for backends that declare how', async () => {
    const plugin: BackendPlugin = {
      id: 'up',
      name: 'Up',
      upgrade: { run: node('console.log("installed 2.0.0")'), latest: node('console.log("2.0.0")') },
      create: () => {
        throw new Error('not used')
      }
    }
    const plain: BackendPlugin = { ...plugin, id: 'plain', upgrade: undefined }
    const m = manager([plugin, plain])
    expect(m.list().map((b) => [b.id, b.upgrade])).toEqual([['up', true], ['plain', false]])
    expect(await m.latestVersion('up')).toBe('2.0.0')
    const lines: string[] = []
    const r = await m.upgrade('up', (l) => lines.push(l))
    expect(r.ok).toBe(true)
    expect(lines.join('\n')).toContain('installed 2.0.0')
    await expect(m.upgrade('plain', () => {})).rejects.toThrow('不支持')
  })

  it('declares Qoder’s upgrade through npm, and backends.json may declare one', () => {
    const qoder = loadPlugins().find((p) => p.id === 'qoder')!
    expect(qoder.upgrade?.run.args).toEqual(['install', '-g', '@qoder-ai/qodercli@latest'])
    const file = join(mkdtempSync(join(tmpdir(), 'oc-up-')), 'backends.json')
    writeFileSync(file, JSON.stringify([{ id: 'x', name: 'X', command: 'x', upgrade: { run: { command: 'npm', args: ['i', '-g', 'x@latest'] } } }]))
    expect(loadPlugins(file).find((p) => p.id === 'x')!.upgrade?.run.command).toBe('npm')
    writeFileSync(file, JSON.stringify([{ id: 'x', name: 'X', command: 'x', upgrade: { run: 'npm i -g x' } }]))
    expect(() => loadPlugins(file)).toThrow('"upgrade"')
  })

  it('uses the proxy for Node’s own downloads when one is set', () => {
    expect(commandEnv({ HTTPS_PROXY: 'http://127.0.0.1:3128' }).NODE_USE_ENV_PROXY).toBe('1')
    expect(commandEnv({}).NODE_USE_ENV_PROXY).toBeUndefined()
  })

  it('says a backend is not installed when its program is not on PATH', async () => {
    expect(await runAccountCheck({ command: 'no-such-program-oc', parse: () => ({ signedIn: true }) })).toEqual({ installed: false })
  })

  it('finds npm’s global folder and adds it to PATH, so a fresh install is found without a restart', async () => {
    const bin = await npmGlobalBin()
    expect(bin && existsSync(bin)).toBeTruthy()
    const env: NodeJS.ProcessEnv = { Path: ['/a', '/b'].join(delimiter) }
    addToPath('/new', env)
    addToPath('/new', env)
    expect(env.Path).toBe(['/new', '/a', '/b'].join(delimiter))
    expect(env.PATH).toBeUndefined()
  })
})

describe('install that leaves the program unfindable', () => {
  it('reports it as not found instead of a success', async () => {
    const { makeCore } = await import('./helpers')
    const { core, dispose } = await makeCore()
    await core.backends.setPlugins([
      ...core.backends.list().map((b) => ({ id: b.id, name: b.name, create: () => { throw new Error('x') } }) as BackendPlugin),
      {
        id: 'ghost',
        name: 'Ghost',
        account: async () => ({ installed: false }),
        upgrade: { run: node('console.log("added 1 package")') },
        create: () => {
          throw new Error('not used')
        }
      }
    ])
    const r = await core.upgradeBackend('ghost')
    expect(r).toMatchObject({ ok: false, notFound: true, account: { installed: false } })
    expect(r.output).toContain('added 1 package')
    await dispose()
  })
})
