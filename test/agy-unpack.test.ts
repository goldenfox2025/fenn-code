import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readPyiArchive, topNames, unpackPyi, unpackedEntries } from '../src/main/backends/pyiArchive'
import { cleanStaleTemp, needsUnpack, unpackServer, unpackedEnv, unpackedFor } from '../src/main/backends/plugins/antigravity'
import { antigravityContext } from '../src/main/backends/sessionLogs'

type Item = { name: string; type: string; data: Buffer | string; compress?: boolean }

/** A program with a PyInstaller CArchive at its end, laid out as PyInstaller writes it. */
function fakeOnefile(items: Item[], trailer = Buffer.alloc(0)): Buffer {
  const head = Buffer.from('MZ fake bootloader '.repeat(50))
  const parts: Buffer[] = []
  const toc: Buffer[] = []
  let at = 0
  for (const it of items) {
    const raw = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data)
    const data = it.compress ? deflateSync(raw) : raw
    parts.push(data)
    const name = Buffer.from(it.name)
    const len = 18 + Math.ceil((name.length + 1) / 16) * 16
    const e = Buffer.alloc(len)
    e.writeUInt32BE(len, 0)
    e.writeUInt32BE(at, 4)
    e.writeUInt32BE(data.length, 8)
    e.writeUInt32BE(raw.length, 12)
    e[16] = it.compress ? 1 : 0
    e.write(it.type, 17, 'latin1')
    name.copy(e, 18)
    toc.push(e)
    at += data.length
  }
  const tocBuf = Buffer.concat(toc)
  const cookie = Buffer.alloc(88)
  Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'latin1').copy(cookie, 0)
  cookie.writeUInt32BE(at + tocBuf.length + 88, 8)
  cookie.writeUInt32BE(at, 12)
  cookie.writeUInt32BE(tocBuf.length, 16)
  cookie.writeUInt32BE(310, 20)
  cookie.write('python310.dll', 24)
  return Buffer.concat([head, ...parts, tocBuf, cookie, trailer])
}

const ITEMS: Item[] = [
  { name: 'struct', type: 'm', data: 'code', compress: true },
  { name: 'pyimod01', type: 'm', data: 'code' },
  { name: 'main', type: 's', data: 'code' },
  { name: 'python310.dll', type: 'b', data: Buffer.alloc(5000, 7), compress: true },
  { name: 'base_library.zip', type: 'x', data: 'zipbytes' },
  { name: 'agy\\templates\\prompt.txt', type: 'x', data: 'hello', compress: true },
  { name: 'certifi/cacert.pem', type: 'x', data: '' },
  { name: 'eggs.zip', type: 'Z', data: 'z' },
  { name: 'PYZ.pyz', type: 'z', data: 'pyz' },
  { name: 'pyi-runtime-option', type: 'o', data: '' },
  { name: 'link.dll', type: 'n', data: 'python310.dll\0' }
]

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'agy-'))
}

describe('unpacking a PyInstaller onefile program ahead', () => {
  it('unpacks exactly what its bootloader would, wherever a code signature follows the archive', async () => {
    const d = dir()
    const exe = join(d, 'server.exe')
    writeFileSync(exe, fakeOnefile(ITEMS, Buffer.alloc(9000, 1)))
    const a = (await readPyiArchive(exe))!
    expect(a.entries).toHaveLength(ITEMS.length)
    expect(unpackedEntries(a)!.map((e) => e.name)).toEqual(['python310.dll', 'base_library.zip', 'agy\\templates\\prompt.txt', 'certifi/cacert.pem', 'eggs.zip', 'link.dll'])
    expect([...topNames(a)].sort()).toEqual(['agy', 'base_library.zip', 'certifi', 'eggs.zip', 'link.dll', 'python310.dll'])
    const r = await unpackPyi(exe, a, join(d, 'out'))
    expect(r).toEqual({ files: 6, bytes: 5000 + 8 + 5 + 0 + 1 })
    expect(readFileSync(join(d, 'out', 'python310.dll'))).toEqual(Buffer.alloc(5000, 7))
    expect(readFileSync(join(d, 'out', 'agy', 'templates', 'prompt.txt'), 'utf8')).toBe('hello')
    expect(readFileSync(join(d, 'out', 'certifi', 'cacert.pem'), 'utf8')).toBe('')
    expect(existsSync(join(d, 'out', 'PYZ.pyz'))).toBe(false)
    expect(readlinkSync(join(d, 'out', 'link.dll'))).toBe('python310.dll')
  })

  it('refuses what it cannot unpack safely, and anything that is not such a program', async () => {
    const d = dir()
    for (const [name, extra] of [
      ['escape', { name: '..\\evil.dll', type: 'b', data: 'x' }],
      ['absolute', { name: 'C:\\Windows\\evil.dll', type: 'x', data: 'x' }],
      ['multipackage', { name: 'other:lib.dll', type: 'd', data: '' }]
    ] as [string, Item][]) {
      writeFileSync(join(d, name), fakeOnefile([...ITEMS, extra]))
      const a = (await readPyiArchive(join(d, name)))!
      expect(unpackedEntries(a), name).toBeUndefined()
      await expect(unpackPyi(join(d, name), a, join(d, `${name}-out`))).rejects.toThrow()
      expect(existsSync(join(d, `${name}-out`))).toBe(false)
    }
    writeFileSync(join(d, 'plain.exe'), Buffer.alloc(100_000, 3))
    expect(await readPyiArchive(join(d, 'plain.exe'))).toBeUndefined()
  })

  it('installs once next to the server, and runs from there only while made from that very file', async () => {
    const d = dir()
    const exe = join(d, 'agy_acp_server.exe')
    writeFileSync(exe, fakeOnefile(ITEMS))
    const home = join(d, '_MEI00000000agy140')
    expect(needsUnpack(exe, 'win32', home)).toBe(true)
    expect(needsUnpack(exe, 'linux', home)).toBe(false)
    const lines: string[] = []
    await unpackServer(exe, (l) => lines.push(l), home)
    expect(lines.at(-1)).toContain('6')
    expect(unpackedFor(exe, home)).toBe(home)
    expect(needsUnpack(exe, 'win32', home)).toBe(false)
    expect(unpackedEnv(exe, home)).toEqual({ _PYI_ARCHIVE_FILE: exe, _PYI_APPLICATION_HOME_DIR: home, _PYI_PARENT_PROCESS_LEVEL: '1' })
    // Again over the old one (an upgrade): replaced, nothing left over.
    await unpackServer(exe, () => undefined, home)
    expect(existsSync(`${home}.part`) || existsSync(`${home}.old`)).toBe(false)
    // Another copy of the server (a new version): back to unpacking itself until set up again.
    writeFileSync(exe, fakeOnefile([...ITEMS, { name: 'new.dll', type: 'b', data: 'n' }]))
    expect(unpackedFor(exe, home)).toBeUndefined()
    expect(needsUnpack(exe, 'win32', home)).toBe(true)
    // One that can't be unpacked ahead is recorded as such, and not offered again.
    const other = join(d, 'plain.exe')
    writeFileSync(other, Buffer.alloc(1000))
    await unpackServer(other, () => undefined, join(d, '_MEI00000000agy999'))
    expect(unpackedFor(other, join(d, '_MEI00000000agy999'))).toBeUndefined()
    expect(needsUnpack(other, 'win32', join(d, '_MEI00000000agy999'))).toBe(false)
  })

  it('deletes only the temp folders earlier runs of this server left, never ones in use or other programs\'', async () => {
    const d = dir()
    const exe = join(d, 'agy_acp_server.exe')
    writeFileSync(exe, fakeOnefile(ITEMS))
    const tmp = join(d, 'tmp')
    const now = Date.now()
    const make = (name: string, entries: string[], ageMin: number) => {
      const p = join(tmp, name)
      mkdirSync(p, { recursive: true })
      for (const e of entries) writeFileSync(join(p, e), 'x')
      const at = (now - ageMin * 60_000) / 1000
      utimesSync(p, at, at)
      return p
    }
    const full = ['python310.dll', 'base_library.zip', 'agy', 'certifi', 'eggs.zip', 'link.dll']
    const left = make('_MEI123456', full, 60)
    const half = make('_MEI0000abcdXyZ123', full.slice(0, 3), 60)
    const fresh = make('_MEI777', full, 1)
    const foreign = make('_MEI888', [...full, 'tcl86t.dll'], 60)
    const tiny = make('_MEI999', full.slice(0, 2), 60)
    const renamed = make('_MEI555-fenn-stale', ['agy'], 60)
    const notMei = make('agy-cache', full, 60)
    expect(await cleanStaleTemp(exe, tmp, now)).toBe(3)
    for (const p of [left, half, renamed]) expect(existsSync(p), p).toBe(false)
    for (const p of [fresh, foreign, tiny, notMei]) expect(lstatSync(p).isDirectory(), p).toBe(true)
  })
})

describe('Antigravity turn usage from its transcript', () => {
  const user = JSON.stringify({ step_type: 'CORTEX_STEP_TYPE_USER_INPUT', created_at: 1 })
  const model = (input: number, out: number, cache = 0) =>
    JSON.stringify({ step_type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', created_at: 2, metadata: { model_usage: { input_tokens: input, cache_read_tokens: cache, output_tokens: out } } })
  it('adds up the model steps since the latest user input, with cache reads apart', () => {
    expect(antigravityContext([user, model(100, 5), user, model(13828, 8)])?.turn).toEqual({ input: 13828, output: 8, total: 13836 })
    expect(antigravityContext([user, model(13828, 40, 12000), JSON.stringify({ step_type: 'TOOL' }), model(14000, 30, 13800)])?.turn).toEqual({
      input: 2028,
      output: 70,
      cachedRead: 25800,
      total: 2098
    })
  })
  it('counts nothing for a turn with no model step yet, and tells turns apart', () => {
    expect(antigravityContext([model(1, 1), user])).toBeUndefined()
    const a = antigravityContext([user, model(10, 2)])!
    const b = antigravityContext([user, model(10, 2), user, model(11, 3)])!
    expect(a.turnKey).not.toBe(b.turnKey)
    // Without the user's input in the part read, only the newest step is surely this turn's.
    expect(antigravityContext([model(5, 1), model(6, 2)])?.turn?.output).toBe(2)
  })
})
