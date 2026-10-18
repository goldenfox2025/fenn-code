import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// The renderer's i18n reads the page's language when loaded.
let util: typeof import('../src/renderer/src/util')
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'zh', setItem() {}, removeItem() {} })
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('document', { documentElement: {} })
  util = await import('../src/renderer/src/util')
})

const RENDERER = join(__dirname, '../src/renderer/src')
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))

describe('typing with an input method', () => {
  it('knows when a key only picks or dismisses candidates', () => {
    expect(util.imeComposing({ isComposing: true, keyCode: 13 } as KeyboardEvent)).toBe(true)
    // Chromium's keydown for a key the IME took: keyCode 229.
    expect(util.imeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } as KeyboardEvent })).toBe(true)
    expect(util.imeComposing({ isComposing: false, keyCode: 13 } as KeyboardEvent)).toBe(false)
  })

  it('never submits on Enter in a text field without asking whether the IME is composing', () => {
    // Menus, the effort slider and a disclosure row take Enter on a button, not in a text field.
    const exempt = /[\\/](Menu|EffortPicker|SidePane)\.tsx$/
    const missing: string[] = []
    for (const f of sources(RENDERER).filter((f) => !exempt.test(f))) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/e\.key === 'Enter'/.test(line)) return
        const around = lines.slice(Math.max(0, i - 10), i + 1).join('\n')
        if (!/imeComposing\(/.test(around)) missing.push(`${f.slice(RENDERER.length + 1)}:${i + 1}`)
      })
    }
    expect(missing).toEqual([])
  })
})

describe('routine times', () => {
  it('show hours and minutes, never seconds', () => {
    const at = new Date(2026, 9, 19, 9, 5, 42).getTime()
    const shown = util.minuteTime(at, new Date(2026, 9, 18).getTime())
    expect(shown).toContain('09:05')
    expect(shown).not.toContain(':42')
    expect(shown).not.toContain('2026')
    expect(util.minuteTime(at, new Date(2025, 0, 1).getTime())).toContain('2026')
  })
})

describe('attachments', () => {
  it('get their real path from the preload, through webUtils', () => {
    const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8')
    expect(preload).toMatch(/exposeInMainWorld\('fennFilePath'/)
    expect(preload).toMatch(/webUtils\.getPathForFile\(/)
    expect(readFileSync(join(RENDERER, 'components/Composer.tsx'), 'utf8')).toMatch(/fennFilePath/)
  })
})

describe('the window never goes blank on a render error', () => {
  it('wraps the app in a top-level error boundary', () => {
    const main = readFileSync(join(RENDERER, 'main.tsx'), 'utf8')
    expect(main).toMatch(/<AppErrorBoundary>\s*<App \/>\s*<\/AppErrorBoundary>/)
  })
})
