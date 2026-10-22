import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { uiDisplayDocument, uiDocument } from '../src/main/core/uiDocument'

describe('embedded conversation UI documents', () => {
  it('offers the host radius scale while preserving authored shapes', () => {
    const tokens = readFileSync(join(__dirname, '../src/renderer/src/tokens.css'), 'utf8')
    const doc = uiDocument('<style>.shape{border-radius:24px}</style><div class="shape">Custom shape</div>')
    for (const [, name, value] of tokens.matchAll(/(--radius-(?:xs|sm|md|lg|xl|pill|circle)):\s*([^;]+);/g)) {
      expect(doc).toContain(`${name}:${value.trim()}`)
    }
    expect(doc).toContain('border-radius:var(--radius-md)')
    expect(doc).toContain('.shape{border-radius:24px}')
  })
  it('repairs saved UI documents at display time without nesting wrappers', () => {
    const saved = '<html><head><style>.card{border-radius:12px}</style></head><body><main data-fenn-ui>Saved UI</main></body></html>'
    const fixed = uiDisplayDocument(saved)
    expect(fixed).toContain('data-fenn-ui-display')
    expect(fixed).toContain('outline-offset:-2px')
    expect(fixed).toContain('.card{border-radius:12px}')
    expect(fixed).toContain('fenn:ui-select')
    expect(fixed).toContain('preventScroll:true')
    expect(fixed).toContain('data-fenn-ui-annotations')
    expect(uiDisplayDocument(fixed)).toBe(fixed)
    // Documents saved with the previous display fix receive the new picker too.
    expect(uiDisplayDocument(saved.replace('</head>', '<style data-fenn-ui-display></style></head>'))).toContain('data-fenn-ui-picker-events')
    expect(uiDisplayDocument(saved.replace('</head>', '<style data-fenn-ui-picker>appearance:base-select</style></head>'))).not.toContain('appearance:base-select')
    const page = '<html><head></head><body>Standalone page</body></html>'
    expect(uiDisplayDocument(page)).toContain('data-fenn-ui-picker-events')
    expect(uiDisplayDocument(page)).not.toContain('data-fenn-ui-layout')
    expect(uiDisplayDocument(page)).not.toContain('data-fenn-ui-display')
  })
  it.each([
    '<!doctype html><html><body><select><option>A</option></select></body></html>',
    '<!doctype html><select><option>A</option></select>',
    '<html><head><meta charset="utf-8"><body><select></select></body></html>',
    '<label>Model<select><option>A</option></select></label>'
  ])('upgrades legacy document shapes without changing their source layout', (source) => {
    const doc = uiDisplayDocument(source)
    expect(doc).toContain('fenn:ui-select')
    expect(doc).toContain('data-fenn-ui-annotations')
    expect(doc).not.toContain('data-fenn-ui-layout')
    expect(uiDisplayDocument(doc)).toBe(doc)
    if (source.startsWith('<!doctype')) expect(doc.startsWith('<!doctype')).toBe(true)
  })
  it('recognizes quoted markers and preserves authored absolute-positioned content', () => {
    const source = '<html><head><style>.marker{position:absolute;top:-20px}</style></head><body><main class="content" data-fenn-ui=""><span class="marker">Limit</span></main></body></html>'
    const doc = uiDisplayDocument(source)
    expect(doc).toContain('data-fenn-ui-layout')
    expect(doc).toContain('.marker{position:absolute;top:-20px}')
  })
  it('keeps a fragment executable with typography, theme variables and a size bridge', () => {
    const fragment = '<button id="choice">Choose</button><script>choice.onclick=()=>choice.textContent="Chosen"</script>'
    const doc = uiDocument(fragment)
    expect(doc).toContain(fragment)
    expect(doc).toContain('data-fenn-ui')
    expect(doc).toContain('fenn:ui-size')
    expect(doc).toContain('fenn:ui-theme')
    expect(doc).toContain('e.source!==parent')
  })
  it('rejects an empty UI instead of publishing an empty wrapper', () => {
    expect(() => uiDocument('  ')).toThrow()
  })
  it.each(['<!doctype html><html></html>', '<body>Full page</body>', '<head><style></style></head>'])('directs full webpages to the page tool: %s', (html) => {
    expect(() => uiDocument(html)).toThrow('publish_page')
  })
})
