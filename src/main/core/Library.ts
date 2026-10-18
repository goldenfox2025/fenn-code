import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LibraryEntry, LibraryChange, Message, ReadOnlyReason } from '../../shared/model'

/**
 * The project's library, as in Claude's 库: what is in the project's working
 * folder, and which files its agents changed. Every path stays inside the
 * folder; a name with .. or a link pointing out of it is refused.
 */

/** Files Windows keeps in folders for itself, hidden as dotfiles are. */
const HIDDEN = new Set(['desktop.ini', 'thumbs.db'])

/** No folder listing grows past this; the rest is reached by opening the folder itself. */
const MAX_ENTRIES = 2000

/** The absolute path of `rel` inside `root`, or undefined when it would leave the folder. */
export function inside(root: string, rel = ''): string | undefined {
  if (isAbsolute(rel)) return undefined
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + sep)) return undefined
  try {
    // A link inside the folder may point anywhere; follow it before trusting it.
    const real = realpathSync(abs)
    const realBase = realpathSync(base)
    if (real !== realBase && !real.startsWith(realBase + sep)) return undefined
  } catch {
    // Not there (yet): the textual check above is all there is. A link that can't be followed is refused.
    if (taken(abs)) return undefined
  }
  return abs
}

/**
 * Where a change to `rel` lands: the entry itself (a link stays a link, never
 * followed), in a folder that really is inside `root`. Never `root` itself.
 */
export function entryPath(root: string, rel: string): string | undefined {
  if (!rel || isAbsolute(rel)) return undefined
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (!abs.startsWith(base + sep)) return undefined
  try {
    const realBase = realpathSync(base)
    const parent = realpathSync(dirname(abs))
    if (parent !== realBase && !parent.startsWith(realBase + sep)) return undefined
    return join(parent, basename(abs))
  } catch {
    return undefined
  }
}

/** Whether two paths are the one entry (a name differing only in case, on a disk that ignores case). */
function sameEntry(a: string, b: string): boolean {
  try {
    const x = lstatSync(a, { bigint: true })
    const y = lstatSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/** Whether anything (a broken link too) has this name. */
function taken(abs: string): boolean {
  try {
    lstatSync(abs)
    return true
  } catch {
    return false
  }
}

/** Text that is not valid UTF-8 (GBK, Shift-JIS…): shown, but never saved back as UTF-8. */
function utf8(buf: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return undefined
  }
}

export function listFolder(root: string, rel = ''): { entries: LibraryEntry[]; truncated: boolean } | undefined {
  const dir = inside(root, rel)
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return undefined
  const entries: LibraryEntry[] = []
  const names = readdirSync(dir).filter((n) => !n.startsWith('.') && !HIDDEN.has(n.toLowerCase()))
  for (const name of names.slice(0, MAX_ENTRIES)) {
    try {
      const st = statSync(join(dir, name))
      entries.push({ name, path: rel ? `${rel}/${name}` : name, dir: st.isDirectory(), size: st.isDirectory() ? undefined : st.size, updatedAt: st.mtimeMs })
    } catch {
      // A broken link or a file removed while listing.
    }
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  return { entries, truncated: names.length > MAX_ENTRIES }
}

/** Tool kinds that change files (ACP ToolKind). */
const CHANGES = new Set(['edit', 'delete', 'move'])

/**
 * Files the agents changed in this folder, newest first: each tool call that
 * edited, deleted or moved files and finished, with the paths it named. A file
 * changed again keeps only its latest change. `formerRoots`: where the agents
 * worked before the folder was chosen (their files moved here).
 */
export function changedFiles(root: string, messages: Message[], formerRoots: string[] = []): LibraryChange[] {
  const seen = new Map<string, LibraryChange>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type !== 'tool' || !b.paths?.length || b.status !== 'completed' || !CHANGES.has(b.toolKind ?? '')) continue
      for (const p of b.paths) {
        // A file made before the chat got its folder was written where the agent worked then, and moved with it.
        const from = formerRoots.find((f) => { const r = relative(resolve(f), resolve(f, p)); return isAbsolute(p) && r && !r.startsWith('..') && !isAbsolute(r) })
        const rel = from ? relative(resolve(from), p) : relative(resolve(root), resolve(root, p))
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
        const path = rel.split(sep).join('/')
        const prev = seen.get(path)
        if (prev && prev.changedAt > m.createdAt) continue
        seen.set(path, { path, kind: b.toolKind as LibraryChange['kind'], changedAt: m.createdAt, conversationId: m.conversationId })
      }
    }
  }
  return [...seen.values()]
    .map((c) => {
      const abs = join(root, c.path)
      try {
        const st = statSync(abs)
        return { ...c, exists: true, size: st.isDirectory() ? undefined : st.size }
      } catch {
        return { ...c, exists: false }
      }
    })
    .sort((a, b) => b.changedAt - a.changedAt)
}

/** The preview shows text up to this size, and images up to IMAGE_MAX. */
const TEXT_MAX = 512 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' }

export function readPreview(root: string, rel: string): { text?: string; size: number; updatedAt: number; image?: string; tooBig?: boolean; binary?: boolean; readOnly?: ReadOnlyReason } | undefined {
  const abs = inside(root, rel)
  if (!abs || !existsSync(abs)) return undefined
  const st = statSync(abs)
  if (!st.isFile()) return undefined
  const base = { size: st.size, updatedAt: st.mtimeMs }
  const mime = IMAGES[extname(abs).toLowerCase()]
  if (mime) {
    if (st.size > IMAGE_MAX) return { ...base, tooBig: true }
    return { ...base, image: `data:${mime};base64,${readFileSync(abs).toString('base64')}` }
  }
  if (st.size > TEXT_MAX) return { ...base, tooBig: true }
  const buf = readFileSync(abs)
  // A NUL in the first few kilobytes: not text.
  if (buf.subarray(0, 8192).includes(0)) return { ...base, binary: true }
  const text = utf8(buf)
  // The byte-order mark is not shown; saving puts it back.
  if (text !== undefined) return { ...base, text: text.replace(/^\uFEFF/, '') }
  // Most likely a Chinese file saved as GBK: shown as such, and read-only.
  return { ...base, text: new TextDecoder('gb18030').decode(buf), readOnly: 'encoding' }
}

/** Why a change to the folder was refused. */
export type LibraryRefusal = 'name' | 'taken' | 'gone' | 'changed' | 'encoding'

/** A name a file can have on every system (and short enough for Windows paths): no separators or reserved characters or Windows device names, not . or .., no trailing dot or space. */
export function fileName(name: string): string | undefined {
  const n = name.trim()
  if (!n || n.length > MAX_NAME || n === '.' || n === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(n) || /[. ]$/.test(n) || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) return undefined
  return n
}

/** Renames a file or folder (a link: the link) in place, never the folder itself; returns its new path, or why not. */
export function renameEntry(root: string, rel: string, name: string): { path: string } | { refused: LibraryRefusal } {
  const abs = entryPath(root, rel)
  if (!abs || !taken(abs)) return { refused: 'gone' }
  const n = fileName(name)
  if (!n) return { refused: 'name' }
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  const path = parent ? `${parent}/${n}` : n
  if (path === rel) return { path }
  const target = entryPath(root, path)
  if (!target) return { refused: 'name' }
  // Only a change of case may land on the same entry (on a disk that ignores case); another file of that name is never replaced.
  if (taken(target) && !sameEntry(target, abs)) return { refused: 'taken' }
  renameSync(abs, target)
  return { path }
}

/** Makes an empty file or folder named `name` in folder `rel`; returns its path, or why not. */
export function createEntry(root: string, rel: string, name: string, dir: boolean): { path: string } | { refused: LibraryRefusal } {
  const parent = inside(root, rel)
  if (!parent || !existsSync(parent) || !statSync(parent).isDirectory()) return { refused: 'gone' }
  const n = fileName(name)
  if (!n) return { refused: 'name' }
  const path = rel ? `${rel}/${n}` : n
  const target = entryPath(root, path)
  if (!target) return { refused: 'name' }
  if (taken(target)) return { refused: 'taken' }
  if (dir) mkdirSync(target)
  else writeFileSync(target, '', { flag: 'wx' })
  return { path }
}

/** The file or folder to delete (a link: the link itself), never the folder itself. */
export function removablePath(root: string, rel: string): string | undefined {
  const abs = entryPath(root, rel)
  return abs && taken(abs) ? abs : undefined
}

/**
 * Saves the text of a file, as UTF-8 (with its byte-order mark if it had
 * one). Only a plain file inside the folder: never through a link, never a
 * file in another encoding. `since` is when it was read for editing: if it
 * changed on disk after that (an agent wrote it), nothing is written unless
 * `force`. Returns the new modification time. `platform`: for tests.
 */
export function writeText(root: string, rel: string, text: string, since?: number, force = false, platform: NodeJS.Platform = process.platform): { updatedAt: number } | { refused: LibraryRefusal } {
  const abs = entryPath(root, rel)
  if (!abs) return { refused: 'gone' }
  let st
  try {
    st = lstatSync(abs)
  } catch {
    return { refused: 'gone' }
  }
  // A link (or a junction) is never written through; entryPath made sure the folder it is in is inside.
  if (!st.isFile()) return { refused: 'gone' }
  if (!force && since !== undefined && Math.abs(st.mtimeMs - since) > 1) return { refused: 'changed' }
  const old = readFileSync(abs)
  if (utf8(old) === undefined) return { refused: 'encoding' }
  const bom = old[0] === 0xef && old[1] === 0xbb && old[2] === 0xbf && !text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const data = Buffer.from(bom + text, 'utf8')
  // The file is opened as it is (never created) and cut to length after writing. Windows has no
  // O_NOFOLLOW (numeric flags made it fail with EINVAL): there the lstat above is the check.
  const fd = openSync(abs, platform === 'win32' ? 'r+' : constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    // A link swapped in between the check and the open: what opened is another file, and is left alone.
    const opened = fstatSync(fd, { bigint: true })
    const checked = lstatSync(abs, { bigint: true })
    if (opened.dev !== checked.dev || opened.ino !== checked.ino || !checked.isFile()) return { refused: 'gone' }
    writeSync(fd, data, 0, data.length, 0)
    ftruncateSync(fd, data.length)
  } finally {
    closeSync(fd)
  }
  return { updatedAt: statSync(abs).mtimeMs }
}

/** Longest name a file added here gets (Windows paths stay well under their limit). */
const MAX_NAME = 120

/** Writes a file into `rel` of the folder under a free name (report.md, report (2).md, …). */
export function addFile(root: string, rel: string, name: string, data: Buffer): string | undefined {
  const dir = inside(root, rel)
  // A name every system takes: reserved characters become _, a trailing dot or space goes, a device name gets a _ in front, and it stays short.
  let base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = '_' + base
  if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME - extname(base).length) + extname(base)
  if (!fileName(base) || !dir || !existsSync(dir) || !statSync(dir).isDirectory()) return undefined
  const ext = extname(base)
  const stem = base.slice(0, base.length - ext.length)
  let target = join(dir, base)
  for (let n = 2; taken(target); n++) target = join(dir, `${stem} (${n})${ext}`)
  writeFileSync(target, data, { flag: 'wx' })
  return target
}
