import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain ESM script without types
import { readStyles } from '../scripts/style-check.mjs'

// The renderer's i18n reads the page's language when loaded.
let rename: typeof import('../src/renderer/src/components/InlineRename')
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'zh', setItem() {}, removeItem() {} })
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('document', { documentElement: {} })
  rename = await import('../src/renderer/src/components/InlineRename')
})

const src = (p: string) => readFileSync(join(__dirname, '../src/renderer/src', p), 'utf8')

describe('inline rename', () => {
  it('keeps a changed, trimmed name and leaves the old one otherwise', () => {
    expect(rename.renameResult('旧名字', '  新名字 ', true)).toBe('新名字')
    expect(rename.renameResult('旧名字', '新名字', false)).toBeNull() // Esc
    expect(rename.renameResult('旧名字', '   ', true)).toBeNull() // emptied
    expect(rename.renameResult('旧名字', '旧名字 ', true)).toBeNull() // unchanged
  })

  it('opens as a field holding the old name', () => {
    const html = renderToStaticMarkup(createElement(rename.RenameInput, { value: '接口排查', onDone: () => {} }))
    expect(html).toMatch(/^<input[^>]*class="rename-input"/)
    expect(html).toContain('value="接口排查"')
  })

  it('is IME-safe: composing keys never save or cancel', () => {
    const code = src('components/InlineRename.tsx')
    expect(code).toMatch(/if \(imeComposing\(e\)\) return\s+if \(e\.key === 'Enter'\)/)
  })

  it('is the one rename used by the sidebar rows, the headers and the threads board', () => {
    for (const f of ['components/Sidebar.tsx', 'views/ChatView.tsx', 'views/ProjectView.tsx']) {
      expect(src(f), f).toMatch(/useRenaming\(\)/)
      expect(src(f), f).toMatch(/<RenameInput/)
    }
    // No dialog any more for renaming a row.
    expect(src('components/Sidebar.tsx')).not.toMatch(/promptDialog/)
    expect(src('views/ChatView.tsx')).not.toMatch(/chat-title-input/)
  })
})

describe('text selection', () => {
  const rules = () => {
    const out: { selector: string; decls: Record<string, string> }[] = []
    postcss.parse(readStyles(join(__dirname, '../src/renderer/src/styles.css'))).walkRules((r) => {
      const decls: Record<string, string> = {}
      r.walkDecls((d) => {
        decls[d.prop] = d.value
      })
      out.push({ selector: r.selector, decls })
    })
    return out
  }

  it('makes the app chrome unselectable with the arrow, from one rule on the body', () => {
    const root = rules().filter((r) => r.selector === 'body' && r.decls['user-select'])
    expect(root).toEqual([{ selector: 'body', decls: { cursor: 'default', 'user-select': 'none' } }])
  })

  it('keeps the conversation, code and fields selectable', () => {
    const all = rules()
    const content = all.find((r) => r.decls['user-select'] === 'text' && r.selector.includes('.transcript'))
    for (const s of ['.transcript', '.md', 'pre', 'code', '.selectable']) expect(content?.selector).toContain(s)
    const fields = all.find((r) => r.decls['user-select'] === 'text' && r.decls.cursor === 'text')
    for (const s of ['input', 'textarea', '[contenteditable]']) expect(fields?.selector).toContain(s)
  })

  it('sets no other text cursor on chrome', () => {
    const iBeam = rules().filter((r) => r.decls.cursor === 'text' || r.decls.cursor === 'auto')
    expect(iBeam.map((r) => r.selector.replace(/\s+/g, ' '))).toHaveLength(2)
  })
})
