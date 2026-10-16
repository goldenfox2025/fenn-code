/**
 * Windows input: one PowerShell process (resources/win-input.ps1) stays
 * running and calls user32 (SendInput, WindowFromPoint, …) through a small C#
 * class compiled once at start. Starting PowerShell and compiling costs a
 * second or two, so doing that per action made every click slow.
 *
 * Protocol: one JSON request per line on stdin; one base64-encoded JSON reply
 * per line on stdout (base64 keeps non-ASCII app names and text safe from the
 * console code page). Text arguments travel base64-encoded too.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { AppRef, Coords, InputDriver, MouseButton } from './drivers'
import { parseChord } from './proc'
import { t } from '../../shared/i18n'

type Request = Record<string, unknown> & { op: string }
type Spawn = () => ChildProcess

/** Starts the helper script (saved with a BOM so Windows PowerShell reads it as UTF-8). */
export function spawnWinHost(script: string): ChildProcess {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

export function parseApp(line: string | null | undefined): AppRef | undefined {
  if (!line) return undefined
  const [pid, id, name] = line.trim().split('\t')
  if (!id) return undefined
  return { id: id.toLowerCase(), name: name || id, pid: Number(pid) || undefined }
}

export class WindowsDriverImpl implements InputDriver {
  readonly name = 'Windows'
  private host?: ChildProcess
  private ready?: Promise<void>
  private seq = 0
  private waiters = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private stderr = ''

  constructor(
    private readonly coords: Coords,
    private readonly spawnHost: Spawn,
    private readonly timeoutMs = 30_000
  ) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawnHost()
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      this.host = child
      this.stderr = ''
      let buf = ''
      const fail = (err: Error): void => {
        reject(err)
        for (const w of this.waiters.values()) w.reject(err)
        this.waiters.clear()
        if (this.host === child) {
          this.host = undefined
          this.ready = undefined
        }
      }
      child.on('error', (e) => fail(new Error(t('无法启动 PowerShell：{0}', e.message))))
      child.on('exit', () => fail(new Error(t('输入组件意外退出。') + this.stderr.trim().slice(-300))))
      child.stderr?.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)))
      child.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let msg: { id: number; ok: boolean; r?: unknown; e?: string }
          try {
            msg = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
          } catch {
            continue
          }
          if (msg.id === 0) {
            resolve()
            continue
          }
          const w = this.waiters.get(msg.id)
          if (!w) continue
          this.waiters.delete(msg.id)
          if (msg.ok) w.resolve(msg.r ?? null)
          else w.reject(new Error(msg.e || t('操作失败')))
        }
      })
    })
    return this.ready
  }

  private async call(req: Request): Promise<unknown> {
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.waiters.delete(id)) return
        reject(new Error(t('输入组件没有响应。')))
        // A stuck host is restarted on the next call.
        this.dispose()
      }, this.timeoutMs)
      this.waiters.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      })
      this.host?.stdin?.write(JSON.stringify({ ...req, id }) + '\n')
    })
  }

  private dev(x: number, y: number): { x: number; y: number } {
    const [dx, dy] = this.coords.toDevice(x, y)
    return { x: Math.round(dx), y: Math.round(dy) }
  }

  async unavailable(): Promise<string | undefined> {
    try {
      await this.call({ op: 'cursor' })
      return undefined
    } catch (e) {
      return t('Windows 输入组件无法工作：{0}', e instanceof Error ? e.message : e)
    }
  }

  async click(x: number, y: number, button: MouseButton, count: number, mods: string[] = []) {
    await this.call({ op: 'click', ...this.dev(x, y), b: button, n: count, mods })
  }
  async move(x: number, y: number) {
    await this.call({ op: 'move', ...this.dev(x, y) })
  }
  async drag(x1: number, y1: number, x2: number, y2: number) {
    const a = this.dev(x1, y1)
    const b = this.dev(x2, y2)
    await this.call({ op: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y })
  }
  async scroll(x: number, y: number, dx: number, dy: number) {
    await this.call({ op: 'scroll', ...this.dev(x, y), dx, dy })
  }
  async type(text: string) {
    await this.call({ op: 'type', s: b64(text) })
  }
  async key(chord: string, repeat = 1) {
    const { mods, key } = parseChord(chord)
    if (!key) throw new Error('没有指定按键')
    await this.call({ op: 'key', keys: [...mods, key], n: repeat, hold: 0 })
  }
  async holdKey(chord: string, ms: number) {
    const { mods, key } = parseChord(chord)
    if (!key) throw new Error('没有指定按键')
    await this.call({ op: 'key', keys: [...mods, key], n: 1, hold: Math.round(ms) })
  }
  async cursor() {
    const r = String((await this.call({ op: 'cursor' })) ?? '0,0')
    const [x, y] = r.split(',').map(Number)
    const [lx, ly] = this.coords.fromDevice(x, y)
    return { x: lx, y: ly }
  }
  async frontmost() {
    return parseApp((await this.call({ op: 'front' })) as string | null)
  }
  async appAt(x: number, y: number) {
    return parseApp((await this.call({ op: 'at', ...this.dev(x, y) })) as string | null)
  }
  async apps() {
    const r = String((await this.call({ op: 'apps' })) ?? '')
    return r
      .split('\n')
      .map(parseApp)
      .filter((a): a is AppRef => !!a)
  }
  async open(name: string) {
    return parseApp((await this.call({ op: 'open', s: b64(name) })) as string | null)
  }
  dispose() {
    const h = this.host
    this.host = undefined
    this.ready = undefined
    h?.kill()
  }
}
