import { existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * Whether a copy of the app is running on `dir` (an older version, under its
 * old name). Windows: Chromium holds `lockfile` open while it runs, so it
 * can't be removed then (and a stale one may go). Elsewhere: `SingletonLock`
 * names the host and the process.
 */
export function inUse(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const lock = join(dir, 'lockfile')
    if (!existsSync(lock)) return false
    try {
      unlinkSync(lock)
      return false
    } catch {
      return true
    }
  }
  let target: string
  try {
    target = readlinkSync(join(dir, 'SingletonLock'))
  } catch {
    return false
  }
  const m = /^(.*)-(\d+)$/.exec(target)
  if (!m || m[1] !== hostname()) return false
  try {
    process.kill(Number(m[2]), 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Moved first and together: the encrypted settings need the key in Local State, so one never moves without the other. */
const TOGETHER = ['Local State', 'data']

/**
 * Moves the app's data from `from` (its folder under an old name) to `to`,
 * never overwriting. `data` and `Local State` move together or not at all;
 * the rest (caches) follows as far as it can. Returns false when nothing
 * moved, and the old folder should be used where it is.
 */
export function moveAppData(from: string, to: string, platform: NodeJS.Platform = process.platform): boolean {
  if (inUse(from, platform)) return false
  mkdirSync(to, { recursive: true })
  const moved: string[] = []
  try {
    for (const name of TOGETHER) {
      if (!existsSync(join(from, name)) || existsSync(join(to, name))) continue
      renameSync(join(from, name), join(to, name))
      moved.push(name)
    }
  } catch {
    // Put back what went, so the old folder stays whole.
    for (const name of moved.reverse()) {
      try {
        renameSync(join(to, name), join(from, name))
      } catch {
        // Left where it is: still found in the new folder next time.
      }
    }
    return existsSync(join(to, 'data'))
  }
  for (const name of readdirSync(from)) {
    if (existsSync(join(to, name))) continue
    try {
      renameSync(join(from, name), join(to, name))
    } catch {
      // A cache held by something else: it is rebuilt.
    }
  }
  try {
    if (!readdirSync(from).length) rmdirSync(from)
  } catch {
    // Not empty yet: left.
  }
  return true
}
