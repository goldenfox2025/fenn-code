/**
 * macOS input through JavaScript for Automation: CoreGraphics events for the
 * mouse and keys, System Events and NSWorkspace for apps. Needs Accessibility
 * permission for Fenn Code. Coordinates are already points, so nothing to convert.
 */
import type { AppRef, InputDriver, MouseButton } from './drivers'
import { parseChord, run, sleep } from './proc'
import { t } from '../../shared/i18n'

const KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111, f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
  capslock: 57, volumeup: 72, volumedown: 73, volumemute: 74,
  cmd: 55, shift: 56, alt: 58, ctrl: 59, fn: 63
}
const FLAGS: Record<string, number> = {
  shift: 0x20000,
  ctrl: 0x40000,
  alt: 0x80000,
  cmd: 0x100000,
  fn: 0x800000
}

export class MacDriverImpl implements InputDriver {
  readonly name = 'macOS'

  /** What macOS still has to allow (Accessibility, Screen Recording), checked by the app shell; undefined when all is allowed. */
  constructor(private readonly access?: () => string | undefined) {}

  async unavailable(): Promise<string | undefined> {
    // Without Accessibility the events are dropped silently, and without Screen Recording the
    // screenshots show only the wallpaper: say so before the agent works blind.
    const missing = this.access?.()
    if (missing) return missing
    try {
      await this.jxa(`Application('System Events').processes.length`)
      return undefined
    } catch (e) {
      return t('macOS 需要授权：在「系统设置 → 隐私与安全性 → 辅助功能」里允许 Fenn Code。（{0}）', e instanceof Error ? e.message : e)
    }
  }

  private jxa(script: string): Promise<string> {
    return run('osascript', ['-l', 'JavaScript', '-e', script])
  }

  /** [eventType, x, y, clickState] */
  private mouse(events: [number, number, number, number?][], button = 0, flags = 0): Promise<string> {
    const body = events
      .map(
        ([t, x, y, n]) =>
          `e=$.CGEventCreateMouseEvent(null,${t},{x:${x},y:${y}},${button});` +
          (n ? `$.CGEventSetIntegerValueField(e,$.kCGMouseEventClickState,${n});` : '') +
          (flags ? `$.CGEventSetFlags(e,${flags});` : '') +
          `$.CGEventPost($.kCGHIDEventTap,e);delay(0.02);`
      )
      .join('')
    return this.jxa(`ObjC.import('CoreGraphics');var e;${body}`)
  }

  async click(x: number, y: number, button: MouseButton, count: number, mods: string[] = []) {
    const [down, up, b] = button === 'right' ? [3, 4, 1] : button === 'middle' ? [25, 26, 2] : [1, 2, 0]
    const flags = mods.reduce((f, m) => f | (FLAGS[m] ?? 0), 0)
    const ev: [number, number, number, number?][] = [[5, x, y]]
    for (let i = 1; i <= count; i++) ev.push([down, x, y, i], [up, x, y, i])
    await this.mouse(ev, b, flags)
  }
  async move(x: number, y: number) {
    await this.mouse([[5, x, y]])
  }
  async drag(x1: number, y1: number, x2: number, y2: number) {
    const steps: [number, number, number][] = []
    for (let i = 1; i <= 12; i++) steps.push([6, x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12])
    await this.mouse([[5, x1, y1], [1, x1, y1], ...steps, [2, x2, y2]])
  }
  async scroll(x: number, y: number, dx: number, dy: number) {
    await this.mouse([[5, x, y]])
    // Line units; positive values scroll up/left on macOS. (CGEventCreateScrollWheelEvent2: macOS 13+.)
    try {
      await this.jxa(
        `ObjC.import('CoreGraphics');var e=$.CGEventCreateScrollWheelEvent2(null,1,2,${-dy * 3},${-dx * 3},0);$.CGEventPost($.kCGHIDEventTap,e);`
      )
    } catch {
      const code = dy > 0 ? 125 : dy < 0 ? 126 : dx > 0 ? 124 : 123
      await this.jxa(`var se=Application('System Events');for(var i=0;i<${Math.abs(dy || dx) * 3};i++)se.keyCode(${code})`)
    }
  }
  async type(text: string) {
    await this.jxa(`Application('System Events').keystroke(${JSON.stringify(text)})`)
  }
  private chordScript(chord: string, holdMs: number, repeat: number): string {
    const { mods, key } = parseChord(chord)
    const code = KEYCODES[key]
    if (code === undefined) throw new Error(`不认识的按键：${key}`)
    const flags = mods.reduce((f, m) => f | (FLAGS[m] ?? 0), 0)
    const modCodes = mods.map((m) => KEYCODES[m]).filter((c) => c !== undefined)
    const ev = (c: number, down: boolean) =>
      `e=$.CGEventCreateKeyboardEvent(null,${c},${down});$.CGEventSetFlags(e,${flags});$.CGEventPost($.kCGHIDEventTap,e);`
    const once =
      modCodes.map((c) => ev(c, true)).join('') +
      ev(code, true) +
      `delay(${Math.max(holdMs, 10) / 1000});` +
      ev(code, false) +
      [...modCodes].reverse().map((c) => ev(c, false)).join('') +
      'delay(0.02);'
    return `ObjC.import('CoreGraphics');var e;for(var r=0;r<${repeat};r++){${once}}`
  }
  async key(chord: string, repeat = 1) {
    await this.jxa(this.chordScript(chord, 0, Math.max(1, repeat)))
  }
  async holdKey(chord: string, ms: number) {
    await this.jxa(this.chordScript(chord, ms, 1))
  }
  async cursor() {
    const r = await this.jxa(`ObjC.import('CoreGraphics');var p=$.CGEventGetLocation($.CGEventCreate(null));p.x+','+p.y`)
    const [x, y] = r.trim().split(',').map(Number)
    return { x, y }
  }

  private static parse(line: string): AppRef | undefined {
    const [pid, id, name] = line.trim().split('\t')
    if (!id && !name) return undefined
    return { id: (id || name).toLowerCase(), name: name || id, pid: Number(pid) || undefined }
  }

  async frontmost() {
    const r = await this.jxa(
      `ObjC.import('AppKit');var a=$.NSWorkspace.sharedWorkspace.frontmostApplication;a.processIdentifier+'\\t'+ObjC.unwrap(a.bundleIdentifier)+'\\t'+ObjC.unwrap(a.localizedName)`
    )
    return MacDriverImpl.parse(r)
  }
  async appAt(x: number, y: number) {
    // Windows are listed front to back; the first normal-layer window containing the point is what a click hits.
    const r = await this.jxa(
      `ObjC.import('CoreGraphics');ObjC.import('AppKit');` +
        `var l=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,0)));` +
        `var out='';for(var i=0;i<l.length;i++){var w=l[i],b=w.kCGWindowBounds;` +
        `if(w.kCGWindowLayer!==0||!b)continue;` +
        `if(${x}>=b.X&&${x}<b.X+b.Width&&${y}>=b.Y&&${y}<b.Y+b.Height){` +
        `var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID);` +
        `out=w.kCGWindowOwnerPID+'\\t'+(a.isNil()?'':ObjC.unwrap(a.bundleIdentifier))+'\\t'+w.kCGWindowOwnerName;break}}out`
    )
    // Nothing at the point: the desktop, which belongs to Finder.
    return MacDriverImpl.parse(r) ?? { id: 'com.apple.finder', name: 'Finder' }
  }
  async apps() {
    const r = await this.jxa(
      `ObjC.import('AppKit');var a=ObjC.unwrap($.NSWorkspace.sharedWorkspace.runningApplications),o=[];` +
        `for(var i=0;i<a.length;i++){if(a[i].activationPolicy!==0)continue;o.push(a[i].processIdentifier+'\\t'+ObjC.unwrap(a[i].bundleIdentifier)+'\\t'+ObjC.unwrap(a[i].localizedName))}o.join('\\n')`
    )
    return r
      .split('\n')
      .map((l) => MacDriverImpl.parse(l))
      .filter((a): a is AppRef => !!a)
  }
  async open(name: string) {
    const isBundleId = /^[a-z0-9-]+(\.[a-z0-9-]+){2,}$/i.test(name)
    try {
      await run('open', isBundleId ? ['-b', name] : ['-a', name])
    } catch {
      throw new Error(`找不到名为「${name}」的程序。`)
    }
    await sleep(800)
    return this.frontmost()
  }
}
