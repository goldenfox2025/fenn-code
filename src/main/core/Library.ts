import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LibraryEntry, LibraryChange, Message } from '../../shared/model'

/**
 * The project's library, as in Claude's 库: what is in the project's working
 * folder, and which files its agents changed. Every path stays inside the
 * folder; a name with .. or a link pointing out of it is refused.
 */

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
    // Not there (yet): the textual check above is all there is.
  }
  return abs
}

export function listFolder(root: string, rel = ''): { entries: LibraryEntry[]; truncated: boolean } | undefined {
  const dir = inside(root, rel)
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return undefined
  const entries: LibraryEntry[] = []
  const names = readdirSync(dir).filter((n) => !n.startsWith('.'))
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

export function readPreview(root: string, rel: string): { text?: string; size: number; image?: string; tooBig?: boolean; binary?: boolean } | undefined {
  const abs = inside(root, rel)
  if (!abs || !existsSync(abs)) return undefined
  const st = statSync(abs)
  if (!st.isFile()) return undefined
  const mime = IMAGES[extname(abs).toLowerCase()]
  if (mime) {
    if (st.size > IMAGE_MAX) return { size: st.size, tooBig: true }
    return { size: st.size, image: `data:${mime};base64,${readFileSync(abs).toString('base64')}` }
  }
  if (st.size > TEXT_MAX) return { size: st.size, tooBig: true }
  const buf = readFileSync(abs)
  // A NUL in the first few kilobytes: not text.
  if (buf.subarray(0, 8192).includes(0)) return { size: st.size, binary: true }
  return { size: st.size, text: buf.toString('utf8') }
}

/** Writes a file into `rel` of the folder under a free name (report.md, report (2).md, …). */
export function addFile(root: string, rel: string, name: string, data: Buffer): string | undefined {
  const dir = inside(root, rel)
  const base = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!dir || !base || base === '.' || base === '..' || !existsSync(dir) || !statSync(dir).isDirectory()) return undefined
  const ext = extname(base)
  const stem = base.slice(0, base.length - ext.length)
  let target = join(dir, base)
  for (let n = 2; existsSync(target); n++) target = join(dir, `${stem} (${n})${ext}`)
  writeFileSync(target, data)
  return target
}
