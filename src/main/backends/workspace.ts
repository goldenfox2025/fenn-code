/**
 * What an agent may touch on this computer through the app: files and
 * commands inside the conversation's working folder. Anything outside it
 * needs the user's say-so first. Protocol-neutral; adapters call into it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, promises as fs, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { t, tk } from '../../shared/i18n'

export interface ExitStatus {
  exitCode: number | null
  signal: string | null
}

interface Terminal {
  sessionId: string
  proc: ChildProcess
  output: string
  truncated: boolean
  limit: number
  exit?: ExitStatus
  exited: Promise<ExitStatus>
}

const DEFAULT_OUTPUT_LIMIT = 1_000_000

/** True when path is root itself or inside it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(root, path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The real location of a path, the way the OS will see it: one part at a
 * time, following every symlink (even dangling ones: writing through one
 * creates the file at its target) and applying `..` to the real directory
 * reached so far, never to the spelling. Nothing is normalized up front,
 * because `link/..` is not the folder that contains `link`.
 */
export function realResolve(path: string, base = process.cwd()): string {
  const split = (p: string) => p.split(/[\\/]+/).filter(Boolean)
  // join() would collapse `..`; build the absolute spelling by hand instead.
  const abs = isAbsolute(path) ? path : `${base}${sep}${path}`
  const { root } = parse(abs)
  const todo = split(abs.slice(root.length))
  let cur = root
  let links = 0
  while (todo.length) {
    const part = todo.shift()!
    if (part === '.') continue
    if (part === '..') {
      cur = dirname(cur)
      continue
    }
    const next = join(cur, part)
    let st
    try {
      st = lstatSync(next)
    } catch {
      // Nothing here yet: the rest gets created as written (`..` still applies).
      cur = next
      continue
    }
    if (!st.isSymbolicLink()) {
      cur = next
      continue
    }
    if (++links > 40) throw new Error(`符号链接嵌套太深：${path}`)
    const target = readlinkSync(next)
    if (isAbsolute(target)) {
      const r = parse(target).root
      cur = r
      todo.unshift(...split(target.slice(r.length)))
    } else todo.unshift(...split(target))
  }
  return cur
}

/** True when path, after following symlinks, is inside root (also followed). */
export function isReallyInside(root: string, path: string): boolean {
  return isInside(realResolve(root), realResolve(path, root))
}

export class Workspaces {
  private roots = new Map<string, string>() // sessionId → working folder
  private terminals = new Map<string, Terminal>()
  private nextId = 1

  /** ask: the user decides about access outside the folder (title, detail) → allowed. */
  constructor(private readonly ask: (sessionId: string, title: string, detail: string) => Promise<boolean>) {}

  setRoot(sessionId: string, root: string | undefined): void {
    if (root) this.roots.set(sessionId, resolve(root))
  }

  rootOf(sessionId: string): string | undefined {
    return this.roots.get(sessionId)
  }

  private async allow(sessionId: string, path: string, what: string): Promise<string> {
    const root = this.roots.get(sessionId)
    // Where the OS will really read or write, following every symlink: a
    // link inside the folder may point anywhere. Work on that real path.
    const full = realResolve(path, root)
    if (root && isInside(realResolve(root), full)) return full
    const ok = await this.ask(sessionId, t(root ? tk('{0}工作文件夹之外的文件') : tk('{0}文件'), t(what)), full)
    if (!ok) throw new Error(`用户没有允许${what}这个文件：${full}`)
    return full
  }

  async readTextFile(sessionId: string, path: string, line?: number | null, limit?: number | null): Promise<string> {
    const text = await fs.readFile(await this.allow(sessionId, path, tk('读取')), 'utf8')
    if (line == null && limit == null) return text
    const lines = text.split('\n')
    const start = Math.max(0, (line ?? 1) - 1)
    return lines.slice(start, limit ? start + limit : undefined).join('\n')
  }

  async writeTextFile(sessionId: string, path: string, content: string): Promise<void> {
    const full = await this.allow(sessionId, path, tk('修改'))
    // Agents expect new folders to appear as needed, like an editor's save.
    await fs.mkdir(dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
  }

  // ---- terminals -----------------------------------------------------------

  /** Runs a command in the working folder (or a folder inside it). */
  async createTerminal(
    sessionId: string,
    req: { command: string; args?: string[]; env?: { name: string; value: string }[]; cwd?: string | null; outputByteLimit?: number | null }
  ): Promise<string> {
    const root = this.roots.get(sessionId)
    if (!root) throw new Error('这个对话没有工作文件夹，不能运行命令。请先在输入框下方选择一个文件夹。')
    const cwd = req.cwd ? realResolve(req.cwd, root) : realResolve(root)
    if (!isInside(realResolve(root), cwd)) throw new Error(`命令只能在工作文件夹里运行：${root}`)
    const env = { ...process.env }
    for (const v of req.env ?? []) env[v.name] = v.value
    // No args: a shell command line, as agents usually send.
    const proc = req.args?.length
      ? spawn(req.command, req.args, { cwd, env, windowsHide: true })
      : spawn(req.command, { cwd, env, shell: true, windowsHide: true })
    const id = `term-${this.nextId++}`
    const t: Terminal = {
      sessionId,
      proc,
      output: '',
      truncated: false,
      limit: req.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      exited: new Promise((done) => {
        proc.on('error', (e) => {
          t.output += `\n${e.message}\n`
          t.exit = { exitCode: 127, signal: null }
          done(t.exit)
        })
        proc.on('close', (code, signal) => {
          t.exit ??= { exitCode: code, signal: signal ?? null }
          done(t.exit)
        })
      })
    }
    const add = (chunk: Buffer) => {
      t.output += chunk.toString('utf8')
      // Keep the end: the latest output matters most.
      while (Buffer.byteLength(t.output) > t.limit) {
        t.output = t.output.slice(Math.ceil(t.output.length / 10))
        t.truncated = true
      }
    }
    proc.stdout?.on('data', add)
    proc.stderr?.on('data', add)
    this.terminals.set(id, t)
    return id
  }

  private terminal(id: string): Terminal {
    const t = this.terminals.get(id)
    if (!t) throw new Error(`没有这个终端：${id}`)
    return t
  }

  output(id: string): { output: string; truncated: boolean; exitStatus: ExitStatus | null } {
    const t = this.terminal(id)
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit ?? null }
  }

  waitForExit(id: string): Promise<ExitStatus> {
    return this.terminal(id).exited
  }

  kill(id: string): void {
    const t = this.terminal(id)
    if (!t.exit) t.proc.kill()
  }

  release(id: string): void {
    const t = this.terminals.get(id)
    if (!t) return
    if (!t.exit) t.proc.kill()
    this.terminals.delete(id)
  }

  /** Ends a session's commands and forgets its folder. */
  close(sessionId: string): void {
    for (const [id, t] of this.terminals) if (t.sessionId === sessionId) this.release(id)
    this.roots.delete(sessionId)
  }
}
