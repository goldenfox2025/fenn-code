/**
 * Finding working folders for the user: paths they mention in a message, and
 * likely project folders (git repositories under the usual places). Nothing
 * here attaches a folder; the app always asks first.
 */
import { existsSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'

// A path starts at a drive letter or at / or ~ that isn't inside a word or URL (Chinese text
// may run right up to it), and runs on, spaces and all, until punctuation that can't be in it.
const WIN_PATH = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\n"'`“”‘’「」『』()（）<>\[\]【】，。,;；!?！？*|]*/g
const POSIX_PATH = /(?<![A-Za-z0-9_.~\/\\:-])(?:~\/|\/)[^\n"'`“”‘’「」『』()（）<>\[\]【】，。,;；!?！？*|:]*/g

/**
 * Stretches of text that start like an absolute (or ~/) path. A stretch may run
 * past the path into the words after it; foldersInText finds where it ends.
 */
export function pathsInText(text: string): string[] {
  const out: string[] = []
  for (const re of [WIN_PATH, POSIX_PATH]) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const p = m[0].replace(/[\s.、:：]+$/, '')
      // A bare "/" or "~" says nothing; neither do URLs' "//host" parts.
      if (p.length < 3 || p.startsWith('//')) continue
      out.push(p)
    }
  }
  return [...new Set(out)]
}

/** The longest start of a stretch that exists on disk (a path may contain spaces, or be followed by words). */
function longestExisting(run: string, home: string): { path: string; length: number } | undefined {
  const max = Math.min(run.length, 260)
  for (let end = max; end >= 3; end--) {
    const prefix = run.slice(0, end)
    // Cut only where a word ends: before a space, before Chinese text, or at the end. Never just
    // before or after a separator, or a missing folder would be offered as its parent.
    const next = run[end] ?? ''
    if (end < run.length && !/[\s　-鿿＀-￯]/.test(next)) continue
    if (end < run.length && /[\\/]$/.test(prefix)) continue
    if (/[\s.、:：]$/.test(prefix) && end < max) continue
    const p = expand(prefix.replace(/[\s.、:：]+$/, ''), home)
    if (isAbsolute(p) && existsSync(p)) return { path: p, length: end }
  }
  return undefined
}

/** System folders nobody means as a working folder. */
const SYSTEM_DIR = /^(\/(etc|usr(?![\\/]local)|bin|sbin|lib|lib64|var|boot|proc|sys|dev|System|Library|private)|[A-Za-z]:[\\/]Windows)([\\/]|$)/i

function expand(p: string, home: string): string {
  const q = p.startsWith('~') ? join(home, p.slice(1)) : p
  return normalize(q)
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The existing folders a message points at: a folder as written, or the
 * folder holding a file it names. Paths that don't exist are skipped.
 */
export function foldersInText(text: string, home = homedir()): string[] {
  const out: string[] = []
  const queue = pathsInText(text)
  const seen = new Set(queue)
  // After a path, the rest of its stretch may hold more paths ("比较 /a 和 /b").
  for (let guard = 0; queue.length && out.length < 3 && guard < 30; guard++) {
    const run = queue.shift()!
    const hit = longestExisting(run, home)
    for (const r of pathsInText(run.slice(hit ? hit.length : 1)))
      if (!seen.has(r)) {
        seen.add(r)
        queue.push(r)
      }
    if (!hit) continue
    const dir = isDir(hit.path) ? hit.path : dirname(hit.path)
    // The home folder, a drive root and system folders are no place to work in.
    if (resolve(dir) === resolve(home) || dirname(dir) === dir || SYSTEM_DIR.test(dir)) continue
    if (!out.includes(dir)) out.push(dir)
  }
  return out
}

import type { FolderCandidate } from '../../shared/model'
export type { FolderCandidate }

const ROOT_NAMES = [
  'Documents',
  'Desktop',
  'Projects',
  'projects',
  'Code',
  'code',
  'dev',
  'Dev',
  'src',
  'repos',
  'Repos',
  'workspace',
  'Workspace',
  'work',
  'GitHub',
  'git',
  'source/repos',
  'Documents/GitHub',
  'Documents/Projects',
  'Documents/Code'
]
const SKIP = new Set(['node_modules', 'Library', 'AppData', 'vendor', 'venv', '.venv', 'dist', 'build', 'out', 'target'])

/**
 * Lazily scans the usual places for git repositories and caches the list.
 * The scan is bounded (depth and folder count) so it never runs long.
 */
export class FolderFinder {
  private cache?: { at: number; list: FolderCandidate[] }
  private running?: Promise<FolderCandidate[]>

  constructor(
    private readonly home = homedir(),
    private readonly opts: { maxDepth?: number; maxVisits?: number; ttlMs?: number } = {}
  ) {}

  roots(): string[] {
    const seen = new Set<string>()
    for (const r of ROOT_NAMES) {
      const p = join(this.home, r)
      if (isDir(p)) seen.add(resolve(p))
    }
    return [...seen]
  }

  async scan(): Promise<FolderCandidate[]> {
    const ttl = this.opts.ttlMs ?? 10 * 60_000
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.list
    this.running ??= this.walk().then((list) => {
      this.cache = { at: Date.now(), list }
      this.running = undefined
      return list
    })
    return this.running
  }

  private async walk(): Promise<FolderCandidate[]> {
    const maxDepth = this.opts.maxDepth ?? 3
    let budget = this.opts.maxVisits ?? 3000
    const found = new Map<string, FolderCandidate>()
    const queue: { dir: string; depth: number }[] = this.roots().map((dir) => ({ dir, depth: 0 }))
    while (queue.length && budget-- > 0) {
      const { dir, depth } = queue.shift()!
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      if (depth > 0 && entries.some((e) => e.name === '.git')) {
        const s = await stat(dir).catch(() => undefined)
        found.set(dir, { path: dir, name: basename(dir), mtime: s?.mtimeMs ?? 0 })
        continue // A repository's own subfolders are not separate projects.
      }
      if (depth >= maxDepth) continue
      for (const e of entries)
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) queue.push({ dir: join(dir, e.name), depth: depth + 1 })
    }
    return [...found.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 200)
  }

  /** Likely folders, those whose name matches the hint first, then the most recently changed. */
  async suggest(hint = '', limit = 6): Promise<FolderCandidate[]> {
    const list = await this.scan()
    return rankFolders(list, hint).slice(0, limit)
  }
}

/** Orders folders by how well their name matches the words of a hint, then by recency. */
export function rankFolders(list: FolderCandidate[], hint: string): FolderCandidate[] {
  const words = hint
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2)
  const score = (f: FolderCandidate) => {
    const n = f.name.toLowerCase().replace(/[-_. ]+/g, '')
    let s = 0
    for (const w of words) {
      const ww = w.replace(/[-_. ]+/g, '')
      if (n === ww) s += 3
      else if (n.includes(ww) || (n.length >= 3 && ww.includes(n))) s += 1
    }
    return s
  }
  return [...list].map((f) => ({ f, s: score(f) })).sort((a, b) => b.s - a.s || b.f.mtime - a.f.mtime).map((x) => x.f)
}

/** Only the folders whose name matches the hint (for suggestions next to a name field). */
export function matchingFolders(list: FolderCandidate[], hint: string): FolderCandidate[] {
  const words = hint.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2)
  if (!words.length) return []
  return rankFolders(list, hint).filter((f) => {
    const n = f.name.toLowerCase().replace(/[-_. ]+/g, '')
    return words.some((w) => n.includes(w.replace(/[-_. ]+/g, '')) || (n.length >= 3 && w.includes(n)))
  })
}
