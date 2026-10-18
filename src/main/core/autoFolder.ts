import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../../shared/i18n'

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

/** The file operations moveContents uses (tests stand in for a file another program holds). */
export interface MoveOps {
  rename(from: string, to: string): void
  copy(from: string, to: string): void
  remove(path: string): void
  sleep(ms: number): void
}

const realOps: MoveOps = {
  rename: renameSync,
  copy: (from, to) => cpSync(from, to, { recursive: true, errorOnExist: false }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A file held open (Windows refuses to move it then), or one a virus scanner holds for a moment. */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])
const WAITS = [50, 100, 200, 400]

/**
 * Moves everything in `from` into `to` (created if needed); copies across drives. All or nothing:
 * when something can't be moved (a file still open in another program), whatever was moved goes
 * back, nothing is deleted, and it throws, so the caller can try again later. Across drives every
 * copy is finished before any original is deleted.
 */
export function moveContents(from: string, to: string, opts: { keepExisting?: boolean } = {}, ops: MoveOps = realOps): void {
  const made = !existsSync(to)
  mkdirSync(to, { recursive: true })
  const renamed: [string, string][] = []
  const toCopy: [string, string][] = []
  const copied: string[] = []
  const undo = () => {
    for (const dest of copied) {
      try {
        ops.remove(dest)
      } catch {
        // Only a copy: the original is still there.
      }
    }
    for (const [src, dest] of renamed.reverse()) {
      try {
        ops.rename(dest, src)
      } catch {
        // Left in the new folder: moved whole, so nothing is lost.
      }
    }
    if (made)
      try {
        rmdirSync(to)
      } catch {
        // Not empty (something couldn't go back): kept.
      }
  }
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dest = join(to, entry)
    // Into a folder the user already has: a name taken there stays theirs, and the agent's copy stays behind.
    if (opts.keepExisting && existsSync(dest)) continue
    for (let i = 0; ; i++) {
      try {
        ops.rename(src, dest)
        renamed.push([src, dest])
        break
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? ''
        if (code === 'EXDEV') {
          toCopy.push([src, dest])
          break
        }
        if (BUSY.has(code) && i < WAITS.length) {
          ops.sleep(WAITS[i])
          continue
        }
        undo()
        throw new Error(t('没能移动 {0}（{1}），所有文件都留在原处。可能有程序正打开着它。', src, code || String(e)))
      }
    }
  }
  // Across drives: copy everything first; only once all of it is there do the originals go.
  for (const [src, dest] of toCopy) {
    // A partial copy is removed again, but never something that was there before.
    if (!existsSync(dest)) copied.push(dest)
    try {
      ops.copy(src, dest)
    } catch (e) {
      undo()
      throw new Error(t('没能复制 {0}（{1}），所有文件都留在原处。', src, (e as NodeJS.ErrnoException).code ?? String(e)))
    }
  }
  for (const [src] of toCopy) {
    try {
      ops.remove(src)
    } catch {
      // Copied whole already: what couldn't be deleted is only a leftover.
    }
  }
}
