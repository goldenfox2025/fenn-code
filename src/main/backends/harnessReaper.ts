import { execFile } from 'node:child_process'

export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  /** When the process started (ms since the epoch). */
  created: number
}

/** The processes under root (its children, their children, ...). */
export function descendants(all: ProcInfo[], root: number): ProcInfo[] {
  const kids = new Map<number, ProcInfo[]>()
  for (const p of all) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p])
  const out: ProcInfo[] = []
  const seen = new Set<number>([root])
  const walk = (pid: number) => {
    for (const k of kids.get(pid) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      walk(k.pid)
    }
  }
  walk(root)
  return out
}

interface Window {
  start: number
  end?: number
  session?: string
}

/** A process may show up a moment after the call that started it returned. */
const GRACE_MS = 3000

/**
 * Antigravity's server starts a localharness program, as its direct child, at each session/new
 * (seen with agy 1.4.0; resume and load are taken to do the same) and keeps it while it runs: it
 * has no session/close. This tells which of those a session started (by when each one started:
 * during that session's session/new, resume or load, with no other session opening at the time)
 * and ends only those, by process id, when the app closes the session. A harness it can't tell
 * apart, or one no longer under the server, is left alone; nothing is ever ended by name alone.
 */
export class HarnessReaper {
  private windows = new Set<Window>()
  private owned = new Map<string, Set<number>>()
  private claimed = new Set<number>()

  constructor(
    private readonly list: () => Promise<ProcInfo[]>,
    private readonly kill: (pid: number) => void,
    private readonly isHarness: (name: string) => boolean = (n) => /^localharness/i.test(n),
    private readonly now: () => number = Date.now
  ) {}

  /** Call as a session/new, resume or load starts; the result is called once it ends. */
  begin(): (session: string) => void {
    const w: Window = { start: this.now() }
    this.windows.add(w)
    return (session) => {
      w.end = this.now()
      w.session = session
    }
  }

  /** Gives every harness that started in exactly one finished window to that window's session. */
  private attribute(all: ProcInfo[], root: number): void {
    const now = this.now()
    for (const p of descendants(all, root)) {
      if (!this.isHarness(p.name) || this.claimed.has(p.pid)) continue
      const hits = [...this.windows].filter((w) => p.created >= w.start - 500 && p.created <= (w.end ?? now) + GRACE_MS)
      if (hits.length !== 1 || !hits[0].session) continue
      this.claimed.add(p.pid)
      const s = hits[0].session
      this.owned.set(s, new Set([...(this.owned.get(s) ?? []), p.pid]))
    }
    // A window long finished has had its say.
    for (const w of this.windows) if (w.end !== undefined && now - w.end > 60_000) this.windows.delete(w)
  }

  /** The session is closed: end the harnesses it started that still run under the server. */
  async release(session: string, root: number | undefined): Promise<number[]> {
    if (!root) return []
    const all = await this.list().catch(() => [] as ProcInfo[])
    this.attribute(all, root)
    const mine = this.owned.get(session)
    this.owned.delete(session)
    for (const w of this.windows) if (w.session === session) this.windows.delete(w)
    if (!mine?.size) return []
    // Checked again now: still under our server and still the harness (a reused id is neither).
    const live = new Map(descendants(all, root).map((p) => [p.pid, p]))
    const ended: number[] = []
    for (const pid of mine) {
      this.claimed.delete(pid)
      const p = live.get(pid)
      if (!p || !this.isHarness(p.name)) continue
      this.kill(pid)
      ended.push(pid)
    }
    return ended
  }

  /** The server exited: whatever it started went with it. */
  reset(): void {
    this.windows.clear()
    this.owned.clear()
    this.claimed.clear()
  }
}

/** Every process on a Windows machine with its parent and start time (PowerShell, a second or two). */
export function listWindowsProcesses(): Promise<ProcInfo[]> {
  const script =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (_err, out) =>
      done(parseProcessList(String(out ?? '')))
    )
  })
}

export function parseProcessList(out: string): ProcInfo[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split('|'))
    .filter((f) => f.length === 4)
    .map(([pid, ppid, name, created]) => ({ pid: Number(pid), ppid: Number(ppid), name, created: Number(created) }))
    .filter((p) => p.pid > 0 && Number.isFinite(p.created))
}

/** Ends one process and what it started, by id. */
export function killWindowsTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
}
