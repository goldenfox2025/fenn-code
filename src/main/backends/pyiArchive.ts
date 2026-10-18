/**
 * Reads the program files packed into a PyInstaller "onefile" executable (its
 * CArchive), so they can be unpacked once into a folder that stays, instead of
 * the program unpacking them into the temp folder on every start. Read-only on
 * the executable; nothing here runs it.
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflate, inflateSync } from 'node:zlib'

const MAGIC = Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'latin1')
const COOKIE = 88
const ENTRY = 18

export interface PyiEntry {
  /** As stored, with either separator. */
  name: string
  offset: number
  length: number
  size: number
  compressed: boolean
  type: string
  /** A symlink's target ('n'). */
  target?: string
}

export interface PyiArchive {
  /** Where the archive starts in the executable; entry offsets count from here. */
  start: number
  entries: PyiEntry[]
}

/** What the program's own bootloader unpacks: binaries, data files, zip files and symlinks. */
const UNPACKED = new Set(['b', 'x', 'Z', 'n'])
/** Kinds this reader doesn't handle (other packages to merge, a splash screen): such a program is left to unpack itself. */
const UNSUPPORTED = new Set(['d', 'l'])

/** The cookie that ends the archive, searched from the end (a code signature may follow it). */
async function findCookie(f: fs.FileHandle, size: number): Promise<number> {
  const chunk = 64 * 1024
  let end = size
  // A signature is a few kilobytes; a few megabytes is far more than enough.
  const floor = Math.max(0, size - 16 * 1024 * 1024)
  while (end > floor + MAGIC.length) {
    const start = Math.max(floor, end - chunk)
    const buf = Buffer.alloc(end - start)
    await f.read(buf, 0, buf.length, start)
    const at = buf.lastIndexOf(MAGIC)
    if (at >= 0) return start + at
    end = start + MAGIC.length - 1
  }
  return -1
}

/** The archive's table of contents; undefined when the file isn't a PyInstaller onefile program. */
export async function readPyiArchive(exe: string): Promise<PyiArchive | undefined> {
  const f = await fs.open(exe, 'r')
  try {
    const { size } = await f.stat()
    const at = await findCookie(f, size)
    if (at < 0 || at + COOKIE > size) return undefined
    const cookie = Buffer.alloc(COOKIE)
    await f.read(cookie, 0, COOKIE, at)
    const length = cookie.readUInt32BE(8)
    const tocOffset = cookie.readUInt32BE(12)
    const tocLength = cookie.readUInt32BE(16)
    const start = at + COOKIE - length
    if (start < 0 || tocOffset + tocLength > length || tocLength > 64 * 1024 * 1024) return undefined
    const toc = Buffer.alloc(tocLength)
    await f.read(toc, 0, tocLength, start + tocOffset)
    const entries: PyiEntry[] = []
    for (let p = 0; p + ENTRY <= toc.length; ) {
      const entryLength = toc.readUInt32BE(p)
      if (entryLength < ENTRY || p + entryLength > toc.length) return undefined
      const e: PyiEntry = {
        offset: toc.readUInt32BE(p + 4),
        length: toc.readUInt32BE(p + 8),
        size: toc.readUInt32BE(p + 12),
        compressed: toc[p + 16] === 1,
        type: String.fromCharCode(toc[p + 17]),
        name: toc.subarray(p + ENTRY, p + entryLength).toString('utf8').replace(/\0+$/, '')
      }
      if (e.offset + e.length > tocOffset) return undefined
      entries.push(e)
      p += entryLength
    }
    // A symlink's data is its target, NUL-terminated.
    for (const e of entries.filter((x) => x.type === 'n')) e.target = (await entryData(f, start, e)).toString('utf8').replace(/\0+$/, '')
    return { start, entries }
  } finally {
    await f.close()
  }
}

async function entryData(f: fs.FileHandle, start: number, e: PyiEntry): Promise<Buffer> {
  const buf = Buffer.alloc(e.length)
  await f.read(buf, 0, e.length, start + e.offset)
  return e.compressed ? inflateSync(buf) : buf
}

/** An entry's path split into parts; undefined for one that would land outside the folder. */
export function safeParts(name: string): string[] | undefined {
  const parts = name.split(/[\\/]+/).filter((x) => x && x !== '.')
  if (!parts.length || isAbsolute(name) || /^[a-z]:/i.test(name) || parts.some((x) => x === '..' || /[\0:]/.test(x))) return undefined
  return parts
}

/** The entries unpacked to disk; undefined when the program has a kind this reader can't unpack. */
export function unpackedEntries(a: PyiArchive): PyiEntry[] | undefined {
  if (a.entries.some((e) => UNSUPPORTED.has(e.type))) return undefined
  const files = a.entries.filter((e) => UNPACKED.has(e.type))
  return files.every((e) => safeParts(e.name)) ? files : undefined
}

/** The names at the top of the unpacked folder: how one of the program's own temp folders is told from another program's. */
export function topNames(a: PyiArchive): Set<string> {
  return new Set((unpackedEntries(a) ?? []).map((e) => safeParts(e.name)![0].toLowerCase()))
}

/**
 * Unpacks the program's files into `dest` (which must not exist yet), as its
 * bootloader would. Symlinks become copies of their target on Windows, where
 * making one needs rights a user may not have.
 */
export async function unpackPyi(exe: string, a: PyiArchive, dest: string, onProgress?: (done: number, total: number) => void): Promise<{ files: number; bytes: number }> {
  const files = unpackedEntries(a)
  if (!files) throw new Error('unsupported archive')
  await fs.mkdir(dest)
  const regular = files.filter((e) => e.type !== 'n')
  let next = 0
  let done = 0
  let bytes = 0
  const one = async (e: PyiEntry) => {
    const path = join(dest, ...safeParts(e.name)!)
    await fs.mkdir(dirname(path), { recursive: true })
    if (e.length === 0) await fs.writeFile(path, '', { flag: 'wx' })
    else {
      const input = createReadStream(exe, { start: a.start + e.offset, end: a.start + e.offset + e.length - 1 })
      const output = createWriteStream(path, { flags: 'wx' })
      if (e.compressed) await pipeline(input, createInflate(), output)
      else await pipeline(input, output)
    }
    bytes += e.size
    onProgress?.(++done, files.length)
  }
  // A few at a time: thousands of small files go faster in parallel.
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < regular.length) await one(regular[next++])
    })
  )
  for (const e of files.filter((x) => x.type === 'n')) {
    const path = join(dest, ...safeParts(e.name)!)
    const target = e.target ?? ''
    const resolved = safeParts(join(dirname(e.name), target).split(sep).join('/'))
    if (!target || isAbsolute(target) || !resolved) throw new Error(`bad link ${e.name}`)
    await fs.mkdir(dirname(path), { recursive: true })
    if (process.platform === 'win32') await fs.cp(join(dest, ...resolved), path, { recursive: true })
    else await fs.symlink(target, path)
    onProgress?.(++done, files.length)
  }
  return { files: files.length, bytes }
}
