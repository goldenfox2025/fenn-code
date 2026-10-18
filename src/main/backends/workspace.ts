/**
 * What an agent may touch on this computer through the app: files and
 * commands inside the conversation's working folder. Anything outside it
 * needs the user's say-so first. Protocol-neutral; adapters call into it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, promises as fs, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { t, tk } from '../../shared/i18n'
import { windowsSafe } from './acp/AcpBackend'

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
const WINDOWS = process.platform === 'win32'

/**
 * Stops a command and whatever it started: a shell line runs its programs as
 * children, and killing only the shell leaves them running (and the command
 * never ends). Elsewhere each command leads its own process group.
 */
/**
 * Stops an agent's program; on Windows with the programs it started. Resolves
 * once it has exited, or after `waitMs` (it is not waited on past that).
 */
export function stopAgentProcess(proc: ChildProcess, waitMs = 3000): Promise<void> {
  const exited = whenExited(proc, waitMs)
  if (WINDOWS && proc.pid && proc.exitCode === null) killTree(proc)
  else proc.kill()
  return exited
}

/** Resolves when the process has exited, or after `waitMs`. */
export function whenExited(proc: ChildProcess, waitMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(done, waitMs)
    timer.unref?.()
    proc.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
}

/**
 * Ends a program that ran too long. On Windows a command through cmd.exe is a child of it, and
 * killing only cmd.exe leaves that running (holding its output open): end the whole tree there.
 */
export function endTree(proc: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32' && proc.pid && proc.exitCode === null && proc.signalCode === null)
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => proc.kill())
  else proc.kill()
}

/**
 * Turns a program's output into text as it arrives. A character split across two chunks is
 * kept until its rest comes. On Windows a console program prints in the console's code page
 * (GBK on Chinese Windows), not UTF-8: once a chunk isn't valid UTF-8, the stream is read as
 * GB18030 (a superset of GBK) from there on. Node tools print UTF-8 and stay as they are.
 */
export function outputDecoder(platform: NodeJS.Platform = process.platform): { write(chunk: Buffer): string; end(): string } {
  const utf8 = new StringDecoder('utf8')
  let gbk: TextDecoder | undefined
  let pending = Buffer.alloc(0)
  const strict = new TextDecoder('utf-8', { fatal: true })
  const legacy = (): TextDecoder | undefined => {
    try {
      return new TextDecoder('gb18030')
    } catch {
      return undefined // Node without full ICU: stay with UTF-8.
    }
  }
  return {
    write(chunk) {
      if (gbk) return gbk.decode(chunk, { stream: true })
      if (platform !== 'win32') return utf8.write(chunk)
      const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const cut = buf.length - incompleteTail(buf)
      try {
        const text = strict.decode(buf.subarray(0, cut))
        pending = Buffer.from(buf.subarray(cut))
        return text
      } catch {
        gbk = legacy()
        pending = Buffer.alloc(0)
        return gbk ? gbk.decode(buf, { stream: true }) : buf.toString('utf8')
      }
    },
    end() {
      if (gbk) return gbk.decode()
      if (platform !== 'win32') return utf8.end()
      const rest = pending
      pending = Buffer.alloc(0)
      try {
        return strict.decode(rest)
      } catch {
        return legacy()?.decode(rest) ?? rest.toString('utf8')
      }
    }
  }
}

/** A program's whole output as text, read the way outputDecoder reads it as it arrives. */
export function decodeOutput(buf: Buffer, platform: NodeJS.Platform = process.platform): string {
  const d = outputDecoder(platform)
  return d.write(buf) + d.end()
}

/** How many bytes at the end begin a UTF-8 character whose rest hasn't arrived (0 to 3). */
function incompleteTail(buf: Buffer): number {
  for (let k = 1; k <= Math.min(3, buf.length); k++) {
    const b = buf[buf.length - k]
    if ((b & 0xc0) === 0x80) continue // a continuation byte: look further back
    const need = b >= 0xf8 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return need > k ? k : 0
  }
  return 0
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return
  try {
    if (WINDOWS) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => proc.kill())
    else process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill()
  }
}

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

/** The user's answer about work outside the folder: once, never, or make that folder the working folder. */
export type AccessDecision = 'allow' | 'adopt' | 'reject'

export interface WorkspaceHooks {
  /** The user decides about work outside the folder; `adopt` is a folder that could become the working folder. */
  ask(sessionId: string, title: string, detail: string, adopt?: string): Promise<AccessDecision>
  /** The session's permission mode lets the agent work anywhere without asking. */
  trusted?(sessionId: string): boolean
  /** A folder the user may make a conversation's working folder (not home, a drive root or the app's data). */
  canWorkIn?(path: string): boolean
  /** The user made `folder` the working folder of a session that had none. */
  adopted?(sessionId: string, folder: string): void
  /** A command started or ended (the app lists running ones as background work). */
  onTerminal?(sessionId: string, e: { id: string; command: string; state: 'running' | 'exited'; exitCode?: number | null; output?: string }): void
}

/** How much of a command's output the background pane keeps and shows: its end. */
export const OUTPUT_KEPT = 16_000

export class Workspaces {
  private roots = new Map<string, string>() // sessionId → where the agent works freely
  // Sessions whose root is the app's private scratch folder: the conversation has no folder of its own yet.
  private scratch = new Set<string>()
  private terminals = new Map<string, Terminal>()
  private nextId = 1

  constructor(private readonly hooks: WorkspaceHooks) {}

  /** folder: the user's working folder; without one the agent works freely in its private `scratch` folder. */
  setRoot(sessionId: string, folder: string | undefined, scratch?: string): void {
    const root = folder ?? scratch
    if (root) this.roots.set(sessionId, resolve(root))
    if (!folder && scratch) this.scratch.add(sessionId)
    else this.scratch.delete(sessionId)
  }

  /** The folder the user could adopt for work at `path`: its project (nearest .git), else the folder itself. */
  private adoptable(sessionId: string, path: string): string | undefined {
    if (!this.scratch.has(sessionId) || !this.hooks.canWorkIn) return
    for (let dir = path; dirname(dir) !== dir; dir = dirname(dir)) {
      if (!this.hooks.canWorkIn(dir)) break
      if (existsSync(join(dir, '.git'))) return dir
    }
    return this.hooks.canWorkIn(path) ? path : undefined
  }

  /** Asks about work outside the root unless the mode trusts the agent; adopting makes that folder the root. */
  private async askOutside(sessionId: string, title: string, detail: string, folder: string): Promise<boolean> {
    if (this.hooks.trusted?.(sessionId)) return true
    const adopt = this.adoptable(sessionId, folder)
    const d = await this.hooks.ask(sessionId, title, detail, adopt)
    if (d === 'adopt' && adopt) {
      this.roots.set(sessionId, resolve(adopt))
      this.scratch.delete(sessionId)
      this.hooks.adopted?.(sessionId, adopt)
    }
    return d !== 'reject'
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
    const title = t(root && !this.scratch.has(sessionId) ? tk('{0}工作文件夹之外的文件') : tk('{0}文件'), t(what))
    if (!(await this.askOutside(sessionId, title, full, dirname(full)))) throw new Error(`用户没有允许${what}这个文件：${full}`)
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
    const line = [req.command, ...(req.args ?? [])].join(' ')
    if (!isInside(realResolve(root), cwd) && !(await this.askOutside(sessionId, t('在工作文件夹之外运行命令'), `${cwd}\n${line}`, cwd)))
      throw new Error(`用户没有允许在这里运行命令：${cwd}`)
    const env = { ...process.env }
    for (const v of req.env ?? []) env[v.name] = v.value
    // No args: a shell command line, as agents usually send. With args on Windows, `npm` and the
    // like are .cmd shims only a shell finds (see windowsSafe).
    const safe = req.args?.length ? windowsSafe(req.command, req.args) : undefined
    const proc = safe
      ? spawn(safe.command, safe.args, { cwd, env, shell: safe.shell, windowsHide: true, detached: !WINDOWS })
      : spawn(req.command, { cwd, env, shell: true, windowsHide: true, detached: !WINDOWS })
    const id = `term-${this.nextId++}`
    const term: Terminal = {
      sessionId,
      proc,
      output: '',
      truncated: false,
      limit: req.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT,
      exited: new Promise((done) => {
        proc.on('error', (e) => {
          term.output += `\n${e.message}\n`
          term.exit = { exitCode: 127, signal: null }
          done(term.exit)
        })
        proc.on('close', (code, signal) => {
          add(out.end() + err.end())
          term.exit ??= { exitCode: code, signal: signal ?? null }
          done(term.exit)
        })
      })
    }
    const out = outputDecoder()
    const err = outputDecoder()
    const add = (text: string) => {
      if (!text) return
      term.output += text
      // Keep the end: the latest output matters most.
      while (Buffer.byteLength(term.output) > term.limit) {
        term.output = term.output.slice(Math.ceil(term.output.length / 10))
        term.truncated = true
      }
    }
    proc.stdout?.on('data', (chunk: Buffer) => add(out.write(chunk)))
    proc.stderr?.on('data', (chunk: Buffer) => add(err.write(chunk)))
    this.terminals.set(id, term)
    this.hooks.onTerminal?.(sessionId, { id, command: line, state: 'running' })
    void term.exited.then((x) =>
      this.hooks.onTerminal?.(sessionId, { id, command: line, state: 'exited', exitCode: x.exitCode, output: term.output.slice(-OUTPUT_KEPT) })
    )
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
    if (!t.exit) killTree(t.proc)
  }

  /** What a session's command has printed so far; undefined once the agent has let it go. */
  outputOf(sessionId: string, id: string): string | undefined {
    const t = this.terminals.get(id)
    return t && t.sessionId === sessionId ? t.output.slice(-OUTPUT_KEPT) : undefined
  }

  /** Stops a session's command from the app (the user pressed stop); false when it is not that session's. */
  stop(sessionId: string, id: string): boolean {
    const t = this.terminals.get(id)
    if (!t || t.sessionId !== sessionId) return false
    if (!t.exit) killTree(t.proc)
    return true
  }

  release(id: string): void {
    const t = this.terminals.get(id)
    if (!t) return
    if (!t.exit) killTree(t.proc)
    this.terminals.delete(id)
  }

  /** Ends every command (the agent stopped, or the app quits). */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.release(id)
  }

  /** Ends a session's commands and forgets its folder. */
  close(sessionId: string): void {
    for (const [id, t] of this.terminals) if (t.sessionId === sessionId) this.release(id)
    this.roots.delete(sessionId)
    this.scratch.delete(sessionId)
  }
}
