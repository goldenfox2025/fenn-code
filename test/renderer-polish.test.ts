import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// The renderer's i18n reads the page's language when loaded.
let tooltip: typeof import('../src/renderer/src/components/Tooltip')
let notes: typeof import('../src/renderer/src/turnNote')
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'zh', setItem() {}, removeItem() {} })
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('document', { documentElement: {} })
  tooltip = await import('../src/renderer/src/components/Tooltip')
  notes = await import('../src/renderer/src/turnNote')
})

const RENDERER = join(__dirname, '../src/renderer/src')
const read = (f: string) => readFileSync(join(RENDERER, f), 'utf8')
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))

/** Just enough of an Element for nameByTip. */
function el(attrs: Record<string, string>, text = '') {
  const a = new Map(Object.entries(attrs))
  return {
    textContent: text,
    getAttribute: (k: string) => a.get(k) ?? null,
    hasAttribute: (k: string) => a.has(k),
    setAttribute: (k: string, v: string) => void a.set(k, v),
    removeAttribute: (k: string) => void a.delete(k),
    attrs: a
  }
}

describe('icon buttons are named after their tip', () => {
  it('keeps the name in step when the tip changes (the send button after 停止)', () => {
    const b = el({ 'data-tip': '停止' })
    tooltip.nameByTip([b as unknown as Element])
    expect(b.getAttribute('aria-label')).toBe('停止')
    b.setAttribute('data-tip', '发送 (Enter)')
    tooltip.nameByTip([b as unknown as Element])
    expect(b.getAttribute('aria-label')).toBe('发送 (Enter)')
    b.removeAttribute('data-tip')
    tooltip.nameByTip([b as unknown as Element])
    expect(b.hasAttribute('aria-label')).toBe(false)
  })

  it('leaves a name set in code, and controls with words of their own, alone', () => {
    const named = el({ 'data-tip': '发送 (Enter)', 'aria-label': '发送' })
    const worded = el({ 'data-tip': '打开' }, '打开文件夹')
    tooltip.nameByTip([named, worded] as unknown as Element[])
    expect(named.getAttribute('aria-label')).toBe('发送')
    expect(worded.hasAttribute('aria-label')).toBe(false)
  })

  it('gives the composer\'s stop and send buttons each their own name', () => {
    const src = read('components/Composer.tsx')
    expect(src).toMatch(/key="stop" className="send-btn stop" aria-label=\{t\('停止'\)\}/)
    expect(src).toMatch(/key="send" className="send-btn" aria-label=\{t\('发送'\)\}/)
  })
})

describe('a turn that ended early ends in one quiet note', () => {
  const o = { agent: 'Antigravity', last: true }
  it('says 已停止 when the user stopped it, with nothing to retry', () => {
    expect(notes.turnNote({ state: 'cancelled' }, o)).toEqual({ kind: 'stopped', text: '已停止', retry: false })
  })
  it('says why it was cut off, offering 重试 only on the last reply that will not resume', () => {
    expect(notes.turnNote({ state: 'cancelled', interrupted: true }, o)).toMatchObject({ kind: 'interrupted', text: '因应用重启中断', retry: true })
    expect(notes.turnNote({ state: 'cancelled', interrupted: true }, { ...o, resumes: true })).toMatchObject({ text: '因应用重启中断，已自动继续', retry: false })
    expect(notes.turnNote({ state: 'cancelled', interrupted: true }, { ...o, last: false })?.retry).toBe(false)
    expect(notes.turnNote({ state: 'cancelled', switchedTo: 'Codex' }, o)).toMatchObject({ kind: 'switched', retry: false })
  })
  it('shows a usage limit as a note with the reset time and 重试, not as an error', () => {
    const raw = 'Usage Limit Reached. Your quota will reset in 56 seconds.'
    const n = notes.turnNote({ state: 'error', error: raw }, o)
    expect(n).toEqual({ kind: 'limit', text: 'Antigravity 的用量到上限了，56 秒后恢复，到时点「重试」。', retry: true, tip: raw })
    expect(n!.text).not.toContain('出错了')
    expect(notes.turnNote({ state: 'error', error: raw }, { ...o, busy: true })?.retry).toBe(false)
    expect(notes.turnNote({ state: 'error', error: 'usage limit reached' }, o)?.text).toBe('Antigravity 的用量到上限了，恢复后点「重试」。')
  })
  it('leaves other failures and finished replies to the error bar and the action row', () => {
    expect(notes.turnNote({ state: 'error', error: '401 Unauthorized' }, o)).toBeNull()
    expect(notes.turnNote({ state: 'done' }, o)).toBeNull()
  })
  it('draws every note the same way, never with the error bar', () => {
    const src = read('components/Transcript.tsx')
    expect(src).not.toMatch(/t\('已停止'\)|msg-error interrupted/)
    expect(src).toMatch(/<TurnNote note=\{note\}/)
  })
})

describe('toggles', () => {
  it('are all the one Switch, a named switch with its state', () => {
    const sw = read('components/Switch.tsx')
    for (const a of ['role="switch"', 'aria-checked={on}', 'aria-label={label}']) expect(sw).toContain(a)
    const elsewhere = sources(RENDERER).filter((f) => !f.endsWith('Switch.tsx') && /className=\{?['"]switch\b/.test(readFileSync(f, 'utf8')))
    expect(elsewhere.map((f) => f.slice(RENDERER.length + 1))).toEqual([])
  })
})

describe('accent colors', () => {
  it('put the accent\'s own text color on accent fills, never a fixed white or black', () => {
    const files = readdirSync(join(RENDERER, 'styles')).map((f) => readFileSync(join(RENDERER, 'styles', f), 'utf8'))
    const bad: string[] = []
    for (const text of files)
      for (const rule of text.split('}')) {
        if (!/background(-color)?:\s*var\(--accent\)/.test(rule)) continue
        const color = /(?:^|[\s;{])color:\s*([^;]+);/.exec(rule)?.[1]
        if (color && color !== 'var(--accent-fg)') bad.push(rule.trim().split('\n')[0] + ' color: ' + color)
      }
    expect(bad).toEqual([])
  })
})
