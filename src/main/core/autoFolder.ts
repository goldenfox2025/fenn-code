import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** A folder name from a conversation title that works on Windows, macOS and Linux. */
export function folderSafeName(title: string, fallback = 'Fenn Code'): string {
  const name = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '')
  return !name || RESERVED.test(name) ? fallback : name
}

/** `root/name`, or `root/name 2`, `root/name 3`… when that is taken. */
export function uniqueDir(root: string, name: string): string {
  let dir = join(root, name)
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${name} ${i}`)
  return dir
}

/** Moves everything in `from` into `to` (created if needed); copies across drives. */
export function moveContents(from: string, to: string, opts: { keepExisting?: boolean } = {}): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dest = join(to, entry)
    // Into a folder the user already has: a name taken there stays theirs, and the agent's copy stays behind.
    if (opts.keepExisting && existsSync(dest)) continue
    try {
      renameSync(src, dest)
    } catch {
      cpSync(src, dest, { recursive: true, errorOnExist: false })
      rmSync(src, { recursive: true, force: true })
    }
  }
}
