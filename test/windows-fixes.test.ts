import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { windowsSafe } from '../src/main/backends/acp/AcpBackend'
import { finishNpmInstall } from '../src/main/backends/npmSetup'
import { decodeOutput, endTree, outputDecoder } from '../src/main/backends/workspace'
import { runAccountCheck } from '../src/main/backends/acp'
import { removeRetrying, renameRetrying, swapIn, unzipStep } from '../src/main/backends/plugins/antigravity'
import { moveContents, type MoveOps } from '../src/main/core/autoFolder'
import { readDeclared } from '../src/main/backends/registry'
import { Store } from '../src/main/store/Store'

/** cmd.exe's second phase on a line: quotes toggle, a caret outside them escapes the next character. */
function cmdPhase2(line: string): string {
  let out = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (!quoted && c === '^') {
      out += line[++i] ?? ''
      continue
    } else if (!quoted && /[&|<>()]/.test(c)) throw new Error(`cmd would act on a bare ${c} in ${line}`)
    out += c
  }
  return out
}

/** How the C runtime (node.exe, most programs) splits a command line into arguments. */
function crtArgs(s: string): string[] {
  const args: string[] = []
  let i = 0
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++
    if (i >= s.length) return args
    let a = ''
    let quoted = false
    while (i < s.length) {
      const c = s[i]
      if (!quoted && (c === ' ' || c === '\t')) break
      if (c === '\\') {
        let n = 0
        while (s[i] === '\\') (n++, i++)
        if (s[i] === '"') {
          a += '\\'.repeat(n >> 1)
          if (n % 2) (a += '"', i++)
        } else a += '\\'.repeat(n)
        continue
      }
      if (c === '"') {
        if (quoted && s[i + 1] === '"') (a += '"', (i += 2))
        else (quoted = !quoted, i++)
        continue
      }
      a += c
      i++
    }
    args.push(a)
  }
}

/**
 * What a program gets from spawn(command, args, { shell: true }) on Windows: Node runs
 * `cmd.exe /d /s /c "<command> <args>"`, cmd expands %VAR% (phase 1) and handles quotes and
 * carets (phase 2). A .cmd shim then passes %* on, which goes through phase 2 once more.
 */
function throughCmd(command: string, args: string[], shim: boolean): string[] {
  const env: Record<string, string> = { PATH: 'C:\\Windows', USERNAME: 'someone' }
  let line = [command, ...args].join(' ')
  line = line.replace(/%([^%]+)%/g, (m, name: string) => env[name.toUpperCase()] ?? m)
  line = cmdPhase2(line)
  const tail = line.slice(line.indexOf(' ') + 1)
  return crtArgs(shim ? cmdPhase2(tail) : tail)
}

describe('windowsSafe quoting for cmd.exe', () => {
  const cases = ['', 'plain', 'a b', '%PATH%', '100%', 'a\\%PATH%', 'say "hi"', '"', '%"', 'a & b | c < d > e ^ f', '(x)', 'C:\\dir with space\\', 'x\\"y', '!x!']

  it('quotes an empty argument instead of dropping it', () => {
    expect(windowsSafe('npx', ['a', '', 'b'], 'win32').args).toEqual(['a', '""', 'b'])
  })

  it('keeps %VAR% from being expanded', () => {
    expect(windowsSafe('npx', ['%PATH%'], 'win32').args).toEqual(['""^%"PATH"^%""'])
  })

  it('every argument reaches the program as it was, directly and through a .cmd shim', () => {
    const { command, args, shell } = windowsSafe('npx', cases, 'win32')
    expect(shell).toBe(true)
    expect(throughCmd(command, args, false)).toEqual(cases)
    expect(throughCmd(command, args, true)).toEqual(cases)
  })

  it('leaves other platforms and .exe paths alone', () => {
    expect(windowsSafe('npx', ['', '%PATH%'], 'linux')).toEqual({ command: 'npx', args: ['', '%PATH%'], shell: false })
    expect(windowsSafe('C:\\x\\agent.exe', ['a b'], 'win32')).toEqual({ command: 'C:\\x\\agent.exe', args: ['a b'], shell: false })
  })
})

describe('the npm post-install check', () => {
  const step = finishNpmInstall(process.execPath, '@scope/pkg', 'bin/postinstall.js')

  it('is one line, so cmd.exe runs all of it on Windows', () => {
    expect(step.args![1]).not.toMatch(/[\r\n]/)
    const safe = windowsSafe(step.command, step.args!, 'win32')
    expect(throughCmd(safe.command, safe.args, false)).toEqual(step.args)
  })

  it('still runs as a script', () => {
    const out = execFileSync(process.execPath, step.args!, { encoding: 'utf8', windowsHide: true })
    expect(out).toContain(process.version)
  })
})

describe('decoding command output', () => {
  const nihao = Buffer.from('你好', 'utf8')

  it('keeps a UTF-8 character split across chunks whole', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const d = outputDecoder(platform)
      const text = d.write(nihao.subarray(0, 1)) + d.write(nihao.subarray(1, 4)) + d.write(nihao.subarray(4)) + d.end()
      expect(text, platform).toBe('你好')
    }
  })

  it('reads a Windows console code page (GBK) on Windows, even split', () => {
    const gbk = Buffer.from([0x6f, 0x6b, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]) // "ok 你好\n"
    const d = outputDecoder('win32')
    const text = d.write(gbk.subarray(0, 4)) + d.write(gbk.subarray(4, 6)) + d.write(gbk.subarray(6)) + d.end()
    expect(text).toBe('ok 你好\n')
  })

  it('keeps UTF-8 on Windows when the program prints UTF-8', () => {
    const d = outputDecoder('win32')
    expect(d.write(Buffer.from('ok ')) + d.write(nihao) + d.end()).toBe('ok 你好')
  })
})

describe('decoding an account check', () => {
  it('reads a whole GBK output on Windows, UTF-8 elsewhere', () => {
    expect(decodeOutput(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), 'win32')).toBe('你好')
    expect(decodeOutput(Buffer.from('你好'), 'linux')).toBe('你好')
  })

  it('passes both streams to parse as text', async () => {
    const status = await runAccountCheck({
      command: process.execPath,
      args: ['-e', 'console.log("已登录"); console.error("账号 a@b")'],
      stderr: true,
      parse: (out) => ({ signedIn: out.includes('已登录'), detail: out.split('\n').filter(Boolean)[1] })
    })
    expect(status).toEqual({ signedIn: true, detail: '账号 a@b' })
  })
})

describe('ending a command that ran too long', () => {
  const fake = () => ({ pid: 999999, exitCode: null, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }

  it('kills the program itself on macOS and Linux', () => {
    const p = fake()
    endTree(p, 'linux')
    expect(p.kill).toHaveBeenCalled()
  })

  it('ends the tree with taskkill on Windows, the program alone when taskkill is missing or fails', () => {
    // A stand-in taskkill that does what each case needs, at once.
    const taskkill = (then: (t: EventEmitter) => void) => {
      const calls: string[][] = []
      const run = ((command: string, args: string[]) => {
        calls.push([command, ...args])
        const t = new EventEmitter()
        queueMicrotask(() => then(t))
        return t
      }) as unknown as typeof import('node:child_process').spawn
      return { run, calls }
    }
    const cases: [string, (t: EventEmitter) => void, boolean][] = [
      ['ends the tree', (t) => t.emit('exit', 0), false],
      ['finds nothing or is refused', (t) => t.emit('exit', 128), true],
      ['is missing', (t) => t.emit('error', Object.assign(new Error('spawn taskkill ENOENT'), { code: 'ENOENT' })), true]
    ]
    return Promise.all(
      cases.map(async ([name, then, killed]) => {
        const p = fake()
        const t = taskkill(then)
        endTree(p, 'win32', t.run)
        await new Promise((r) => setTimeout(r, 0))
        expect(t.calls, name).toEqual([['taskkill', '/pid', '999999', '/T', '/F']])
        expect(p.kill.mock.calls.length, name).toBe(killed ? 1 : 0)
      })
    )
  })
})

describe('Antigravity install on Windows and Linux', () => {
  const err = (code: string) => Object.assign(new Error(code), { code })

  it('retries a rename Windows refuses for a moment', async () => {
    let calls = 0
    await renameRetrying('a', 'b', async () => {
      if (++calls < 3) throw err('EBUSY')
    }, [0, 0, 0])
    expect(calls).toBe(3)
  })

  it('gives up on a rename that keeps failing, and at once on other errors', async () => {
    let calls = 0
    await expect(renameRetrying('a', 'b', async () => (calls++, Promise.reject(err('EPERM'))), [0, 0])).rejects.toThrow('EPERM')
    expect(calls).toBe(3)
    calls = 0
    await expect(renameRetrying('a', 'b', async () => (calls++, Promise.reject(err('ENOENT'))), [0, 0])).rejects.toThrow('ENOENT')
    expect(calls).toBe(1)
  })

  it('retries removing a folder Windows holds, and reports when it is still there', async () => {
    let calls = 0
    expect(await removeRetrying('d', async () => {
      if (++calls < 3) throw err('EBUSY')
    }, [0, 0, 0])).toBe(true)
    expect(calls).toBe(3)
    calls = 0
    expect(await removeRetrying('d', async () => (calls++, Promise.reject(err('EPERM'))), [0, 0])).toBe(false)
    expect(calls).toBe(3)
  })

  it('removes the old unpacked folder only once the new one is in, and keeps it when it cannot go', async () => {
    const log: string[] = []
    const dirs = new Set(['home', 'part'])
    const ops = {
      exists: (p: string) => dirs.has(p),
      rename: async (from: string, to: string) => {
        log.push(`mv ${from} ${to}`)
        dirs.delete(from)
        dirs.add(to)
      },
      remove: async (p: string) => (log.push(`rm ${p}`), !dirs.has(p))
    }
    // The old folder stays held: the new one is in place anyway, nothing is thrown.
    await swapIn('part', 'home', ops)
    expect(log).toEqual(['rm home.old', 'mv home home.old', 'mv part home', 'rm home.old'])
    expect([...dirs].sort()).toEqual(['home', 'home.old'])
    // Next time the stale one is still held: this old one goes aside under another name.
    log.length = 0
    dirs.add('part')
    await swapIn('part', 'home', ops)
    expect(log[1]).toMatch(/^mv home home\.old-\d+$/)
    expect(dirs.has('home')).toBe(true)
  })

  it('puts the old unpacked folder back when the new one cannot be moved in', async () => {
    const dirs = new Set(['home', 'part'])
    const ops = {
      exists: (p: string) => dirs.has(p),
      rename: async (from: string, to: string) => {
        if (from === 'part') throw err('EPERM')
        dirs.delete(from)
        dirs.add(to)
      },
      remove: async () => true
    }
    await expect(swapIn('part', 'home', ops)).rejects.toThrow('EPERM')
    expect(dirs.has('home')).toBe(true)
    expect(dirs.has('home.old')).toBe(false)
  })

  it('unpacks the zip with tar on Windows and macOS, unzip (or Python) on Linux', () => {
    const bin = mkdtempSync(join(tmpdir(), 'oc-bin-'))
    expect(unzipStep('s.zip', 'd', 'win32').command).toBe('tar')
    expect(unzipStep('s.zip', 'd', 'darwin').args).toEqual(['-xf', 's.zip', '-C', 'd'])
    // Neither: unzip, and the label says to install it.
    const none = unzipStep('s.zip', 'd', 'linux', { PATH: bin })
    expect(none.command).toBe('unzip')
    expect(none.label).toContain('apt install unzip')
    // findOnPath looks for .exe on a Windows machine.
    const exe = process.platform === 'win32' ? '.exe' : ''
    writeFileSync(join(bin, 'python3' + exe), '')
    expect(unzipStep('s.zip', 'd', 'linux', { PATH: bin }).args).toEqual(['-I', '-m', 'zipfile', '-e', 's.zip', 'd'])
    writeFileSync(join(bin, 'unzip' + exe), '')
    const unzip = unzipStep('s.zip', 'd', 'linux', { PATH: bin })
    expect(unzip).toMatchObject({ command: 'unzip', args: ['-o', 's.zip', '-d', 'd'] })
    expect(unzip.label).not.toContain('apt')
  })
})

describe('moving a chat folder with a file still open', () => {
  const setup = () => {
    const from = mkdtempSync(join(tmpdir(), 'oc-mv-'))
    const to = join(mkdtempSync(join(tmpdir(), 'oc-mv-')), 'chat')
    writeFileSync(join(from, 'a.txt'), 'a')
    mkdirSync(join(from, 'b'))
    writeFileSync(join(from, 'b', 'inner.txt'), 'b')
    writeFileSync(join(from, 'c.txt'), 'c')
    return { from, to }
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const real: MoveOps = {
    rename: renameSync,
    copy: (a, b) => cpSync(a, b, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
    sleep: () => {}
  }

  it('puts back what it moved and deletes nothing when one entry stays busy', () => {
    const { from, to } = setup()
    let tries = 0
    const ops: MoveOps = { ...real, rename: (a, b) => (a === join(from, 'b') ? (tries++, (() => { throw err('EBUSY') })()) : real.rename(a, b)) }
    expect(() => moveContents(from, to, {}, ops)).toThrow('EBUSY')
    expect(tries).toBe(5)
    expect(readdirSync(from).sort()).toEqual(['a.txt', 'b', 'c.txt'])
    expect(existsSync(to)).toBe(false)
  })

  it('moves once a busy entry frees up', () => {
    const { from, to } = setup()
    let tries = 0
    const ops: MoveOps = { ...real, rename: (a, b) => (a === join(from, 'b') && ++tries < 3 ? (() => { throw err('EPERM') })() : real.rename(a, b)) }
    moveContents(from, to, {}, ops)
    expect(readdirSync(from)).toEqual([])
    expect(readFileSync(join(to, 'b', 'inner.txt'), 'utf8')).toBe('b')
  })

  it('across drives, copies everything before deleting, and keeps every original if a copy fails', () => {
    const { from, to } = setup()
    const cross: MoveOps = { ...real, rename: () => { throw err('EXDEV') } }
    expect(() => moveContents(from, to, {}, { ...cross, copy: (a, b) => (a.endsWith('c.txt') ? (() => { throw err('EBUSY') })() : real.copy(a, b)) })).toThrow()
    expect(readdirSync(from).sort()).toEqual(['a.txt', 'b', 'c.txt'])
    expect(readFileSync(join(from, 'b', 'inner.txt'), 'utf8')).toBe('b')
    expect(existsSync(to)).toBe(false)
    moveContents(from, to, {}, cross)
    expect(readdirSync(from)).toEqual([])
    expect(readdirSync(to).sort()).toEqual(['a.txt', 'b', 'c.txt'])
  })
})

describe('backends.json saved with a byte order mark', () => {
  it('parses', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'oc-bom-')), 'backends.json')
    writeFileSync(file, '\uFEFF[]')
    expect(readDeclared(file)).toEqual([])
  })
})

describe('saving when the disk refuses', () => {
  it('never throws, keeps the change, and saves it on the next try', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-store-'))
    const store = new Store(dir)
    const write = store.writeFile
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    store.writeFile = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    store.patchSettings({ userName: '保存失败时' })
    expect(() => store.flush()).not.toThrow()
    expect(errors).toHaveBeenCalled()
    expect(store.settings.userName).toBe('保存失败时')
    store.writeFile = write
    store.flush()
    errors.mockRestore()
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).settings.userName).toBe('保存失败时')
  })
})
