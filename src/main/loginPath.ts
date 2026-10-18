import { existsSync, readdirSync } from 'node:fs'
import { posix } from 'node:path'

// Only for macOS and Linux paths, wherever the code runs (tests run on Windows too).
const { join } = posix

/**
 * Where agent CLIs usually live on macOS and Linux, beyond the bare PATH an app opened from the Dock
 * or a launcher gets: Homebrew, npm's user prefix, Volta, pipx/uv, and nvm's Node versions (newest first).
 * Added after the login shell's PATH, so they help when that shell is slow or fails.
 */
export function usualBinDirs(home: string, platform: NodeJS.Platform = process.platform, exists: (dir: string) => boolean = existsSync,
  list: (dir: string) => string[] = (d) => { try { return readdirSync(d) } catch { return [] } }): string[] {
  if (platform === 'win32') return []
  const nvm = join(home, '.nvm', 'versions', 'node')
  const versions = list(nvm)
    .filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.slice(1).localeCompare(a.slice(1), undefined, { numeric: true }))
    .map((v) => join(nvm, v, 'bin'))
  const dirs = [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    ...versions
  ]
  return dirs.filter((d) => exists(d))
}

/** PATH with the login shell's entries first, then the current ones, then the usual places; each once. */
export function mergePath(shell: string | undefined, current: string | undefined, usual: string[]): string {
  const all = [...(shell ?? '').split(':'), ...(current ?? '').split(':'), ...usual]
  return [...new Set(all.filter(Boolean))].join(':')
}
