/**
 * Linux input through xdotool (X11 only: Wayland sessions don't allow
 * synthetic input). Apps are identified by their process name.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AppRef, Coords, InputDriver, MouseButton } from './drivers'
import { parseChord, run, sleep } from './proc'
import { t } from '../../shared/i18n'

const X_KEYS: Record<string, string> = {
  enter: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'BackSpace',
  delete: 'Delete',
  space: 'space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
  insert: 'Insert',
  capslock: 'Caps_Lock',
  printscreen: 'Print',
  menu: 'Menu',
  volumeup: 'XF86AudioRaiseVolume',
  volumedown: 'XF86AudioLowerVolume',
  volumemute: 'XF86AudioMute',
  '+': 'plus',
  '-': 'minus',
  '=': 'equal',
  '/': 'slash',
  '\\': 'backslash',
  ',': 'comma',
  '.': 'period',
  ';': 'semicolon',
  "'": 'apostrophe',
  '[': 'bracketleft',
  ']': 'bracketright',
  '`': 'grave'
}
const X_MODS: Record<string, string> = { ctrl: 'ctrl', shift: 'shift', alt: 'alt', cmd: 'super' }
const X_BUTTON: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' }

function procName(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

export class LinuxDriverImpl implements InputDriver {
  readonly name = 'xdotool'
  constructor(private readonly coords: Coords) {}

  async unavailable(): Promise<string | undefined> {
    if (process.env.XDG_SESSION_TYPE === 'wayland' && !process.env.DISPLAY)
      return t('当前是 Wayland 桌面，系统不允许程序模拟鼠标键盘。请切换到 X11 会话后再试。')
    try {
      await run('xdotool', ['version'])
      return undefined
    } catch {
      return t('需要先安装 xdotool（例如 sudo apt install xdotool）。')
    }
  }

  private p(x: number, y: number): [string, string] {
    const [dx, dy] = this.coords.toDevice(x, y)
    return [String(Math.round(dx)), String(Math.round(dy))]
  }
  private keysym(chord: string): string {
    const { mods, key } = parseChord(chord)
    if (!key) throw new Error('没有指定按键')
    const k = X_KEYS[key] ?? (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key)
    return [...mods.map((m) => X_MODS[m] ?? m), k].join('+')
  }

  async click(x: number, y: number, button: MouseButton, count: number, mods: string[] = []) {
    const m = mods.map((k) => X_MODS[k] ?? k)
    const args = ['mousemove', ...this.p(x, y)]
    if (m.length) args.push('keydown', m.join('+'))
    args.push('click', '--repeat', String(count), '--delay', '60', X_BUTTON[button])
    if (m.length) args.push('keyup', m.join('+'))
    await run('xdotool', args)
  }
  async move(x: number, y: number) {
    await run('xdotool', ['mousemove', ...this.p(x, y)])
  }
  async drag(x1: number, y1: number, x2: number, y2: number) {
    const args = ['mousemove', ...this.p(x1, y1), 'mousedown', '1']
    for (let i = 1; i <= 12; i++) args.push('mousemove', ...this.p(x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12), 'sleep', '0.012')
    args.push('mouseup', '1')
    await run('xdotool', args)
  }
  async scroll(x: number, y: number, dx: number, dy: number) {
    const args = ['mousemove', ...this.p(x, y)]
    if (dy) args.push('click', '--repeat', String(Math.abs(dy)), dy > 0 ? '5' : '4')
    if (dx) args.push('click', '--repeat', String(Math.abs(dx)), dx > 0 ? '7' : '6')
    await run('xdotool', args)
  }
  async type(text: string) {
    // xdotool decodes the text with the C library's locale. LANG may name a UTF-8 locale
    // that isn't installed, so always use the built-in one.
    const env = { ...process.env, LC_ALL: 'C.UTF-8' }
    // Characters without a key (e.g. Chinese) are typed by remapping a spare key. Some window
    // managers (openbox) then see consecutive ones twice, so each gets its own call and a pause.
    for (const part of text.match(/[\x00-\x7f]+|[^\x00-\x7f]/gu) ?? []) {
      await run('xdotool', ['type', '--delay', '8', '--', part], undefined, 60_000, env)
      if (/[^\x00-\x7f]/.test(part)) await sleep(30)
    }
  }
  async key(chord: string, repeat = 1) {
    await run('xdotool', ['key', '--clearmodifiers', '--repeat', String(Math.max(1, repeat)), this.keysym(chord)])
  }
  async holdKey(chord: string, ms: number) {
    const k = this.keysym(chord)
    await run('xdotool', ['keydown', k])
    try {
      await sleep(ms)
    } finally {
      await run('xdotool', ['keyup', k])
    }
  }
  async cursor() {
    const out = await run('xdotool', ['getmouselocation', '--shell'])
    const x = Number(/X=(\d+)/.exec(out)?.[1] ?? 0)
    const y = Number(/Y=(\d+)/.exec(out)?.[1] ?? 0)
    const [lx, ly] = this.coords.fromDevice(x, y)
    return { x: lx, y: ly }
  }

  private async appOfWindow(win: string): Promise<AppRef | undefined> {
    try {
      const pid = Number((await run('xdotool', ['getwindowpid', win])).trim())
      const id = procName(pid)
      if (!id) return undefined
      let name = id
      try {
        name = (await run('xdotool', ['getwindowclassname', win])).trim() || id
      } catch {
        /* older xdotool */
      }
      return { id: id.toLowerCase(), name, pid }
    } catch {
      return undefined
    }
  }
  async frontmost() {
    try {
      return this.appOfWindow((await run('xdotool', ['getactivewindow'])).trim())
    } catch {
      return undefined
    }
  }
  async appAt(x: number, y: number) {
    // Moving there first is harmless: every caller is about to act at this point.
    const out = await run('xdotool', ['mousemove', ...this.p(x, y), 'getmouselocation', '--shell'])
    const win = /WINDOW=(\d+)/.exec(out)?.[1]
    if (!win) return undefined
    const direct = await this.appOfWindow(win)
    if (direct) return direct
    if (win === (await this.rootWindow())) return undefined
    // Window managers put each app's window inside a frame of their own, and the
    // pointer reports the frame. The app's window is a child of it.
    for (const child of await this.clientsIn(win)) {
      const app = await this.appOfWindow(child)
      if (app) return app
    }
    return undefined
  }
  private root?: string
  private async rootWindow(): Promise<string | undefined> {
    if (!this.root) this.root = (await run('xdotool', ['search', '--maxdepth', '0', '']).catch(() => '')).trim().split('\n')[0] || undefined
    return this.root
  }
  /** Windows inside a frame, outermost first. */
  private async clientsIn(frame: string): Promise<string[]> {
    let tree = ''
    try {
      tree = await run('xwininfo', ['-tree', '-id', frame])
    } catch {
      return this.clientsByGeometry(frame)
    }
    return [...tree.matchAll(/^\s+(0x[0-9a-f]+) /gim)].map((m) => String(Number(m[1])))
  }
  /** Without xwininfo (x11-utils): the largest app window that lies inside the frame. */
  private async clientsByGeometry(frame: string): Promise<string[]> {
    try {
      const f = await this.geometry(frame)
      const ids = (await run('xdotool', ['search', '--onlyvisible', '--name', '.'])).split('\n').filter(Boolean)
      let best: { id: string; area: number } | undefined
      for (const id of ids.slice(0, 200)) {
        if (id === frame) continue
        const g = await this.geometry(id)
        // Old xdotool misplaces framed windows by the frame's border, so compare centres and sizes.
        const cx = g.x + g.w / 2
        const cy = g.y + g.h / 2
        const inside = g.w <= f.w && g.h <= f.h && cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h
        if (inside && (!best || g.w * g.h > best.area) && (await this.appOfWindow(id))) best = { id, area: g.w * g.h }
      }
      return best ? [best.id] : []
    } catch {
      return []
    }
  }
  private async geometry(win: string) {
    const out = await run('xdotool', ['getwindowgeometry', '--shell', win])
    const n = (k: string) => Number(new RegExp(`^${k}=(-?\\d+)`, 'm').exec(out)?.[1] ?? NaN)
    return { x: n('X'), y: n('Y'), w: n('WIDTH'), h: n('HEIGHT') }
  }
  async apps() {
    // Windows come and go while an app is being controlled; a search that trips over one
    // closing (BadWindow) or finds nothing is tried again.
    let ids: string[] = []
    for (let i = 0; i < 3 && !ids.length; i++) {
      if (i) await sleep(150)
      ids = (await run('xdotool', ['search', '--onlyvisible', '--name', '.']).catch(() => '')).split('\n').filter(Boolean)
    }
    const seen = new Map<string, AppRef>()
    for (const w of ids.slice(0, 200)) {
      const a = await this.appOfWindow(w)
      if (a && !seen.has(a.id)) seen.set(a.id, a)
    }
    return [...seen.values()]
  }
  async open(name: string) {
    const front = (await this.apps()).find((a) => a.id === name.toLowerCase() || a.name.toLowerCase() === name.toLowerCase())
    if (front?.pid) {
      try {
        // Two steps, with an explicit empty pattern: xdotool 3.2016 (Ubuntu 22.04, Debian 12)
        // rejects a search without one, and a chained windowactivate.
        // That version also returns windows of other processes, so check each one's owner.
        let found: string[] = []
        for (let i = 0; i < 3 && !found.length; i++) {
          if (i) await sleep(150)
          found = (await run('xdotool', ['search', '--onlyvisible', '--pid', String(front.pid), '']).catch(() => '')).split('\n').filter(Boolean)
        }
        let win: string | undefined
        for (const w of found) {
          const pid = Number((await run('xdotool', ['getwindowpid', w]).catch(() => '')).trim())
          if (pid === front.pid) win = w
        }
        if (!win) throw new Error('no window')
        try {
          await run('xdotool', ['windowactivate', '--sync', win], undefined, 5000)
        } catch {
          // No window manager that takes activation requests: give it the keyboard directly.
          await run('xdotool', ['windowraise', win, 'windowfocus', '--sync', win], undefined, 5000)
        }
        return (await this.frontmost()) ?? front
      } catch {
        /* fall through to launching */
      }
    }
    const exec = desktopExec(name)
    const cmd = exec ?? name
    const child = spawn('/bin/sh', ['-c', `exec ${exec ? cmd : shellQuote(cmd)}`], { detached: true, stdio: 'ignore', windowsHide: true })
    const failed = await new Promise<boolean>((resolve) => {
      child.once('error', () => resolve(true))
      child.once('exit', (code) => resolve(code === 127))
      setTimeout(() => resolve(false), 1500)
    })
    if (failed) throw new Error(`找不到名为「${name}」的程序。`)
    child.unref()
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      const f = await this.frontmost()
      if (f && (f.pid === child.pid || f.id.includes(basename(cmd.split(' ')[0]).toLowerCase()))) return f
    }
    return this.frontmost()
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The Exec line of the installed app whose name matches, without field codes. */
export function desktopExec(name: string, dirs = defaultAppDirs()): string | undefined {
  const q = name.toLowerCase()
  let partial: string | undefined
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.desktop'))
    } catch {
      continue
    }
    for (const f of files) {
      let text = ''
      try {
        text = readFileSync(join(dir, f), 'utf8')
      } catch {
        continue
      }
      const entry = text.split(/\n\[/)[0]
      const names = [...entry.matchAll(/^Name(?:\[[^\]]+\])?=(.+)$/gm)].map((m) => m[1].trim().toLowerCase())
      const exec = /^Exec=(.+)$/m.exec(entry)?.[1]
      if (!exec || /^NoDisplay=true/m.test(entry)) continue
      const clean = exec.replace(/\s+%[a-zA-Z]/g, '').trim()
      if (names.includes(q) || f.slice(0, -8).toLowerCase() === q) return clean
      if (!partial && names.some((n) => n.includes(q))) partial = clean
    }
  }
  return partial
}

function defaultAppDirs(): string[] {
  const data = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  return [join(homedir(), '.local/share/applications'), ...data.map((d) => join(d, 'applications'))]
}
