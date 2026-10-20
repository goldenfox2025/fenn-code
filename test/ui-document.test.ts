import { describe, expect, it } from 'vitest'
import { uiDisplayDocument, uiDocument } from '../src/main/core/uiDocument'

describe('embedded conversation UI documents', () => {
  it('repairs saved UI documents at display time without nesting wrappers', () => {
    const saved = '<html><head><style>.card{border-radius:12px}</style></head><body><main data-fenn-ui>Saved UI</main></body></html>'
    const fixed = uiDisplayDocument(saved)
    expect(fixed).toContain('data-fenn-ui-display')
    expect(fixed).toContain('outline-offset:-2px')
    expect(fixed).toContain('.card{border-radius:12px}')
    expect(fixed).toContain('appearance:base-select')
    expect(fixed).toContain('width:anchor-size(width)')
    expect(uiDisplayDocument(fixed)).toBe(fixed)
    // Documents saved with the previous display fix receive the new picker too.
    expect(uiDisplayDocument(saved.replace('</head>', '<style data-fenn-ui-display></style></head>'))).toContain('data-fenn-ui-picker')
    const page = '<html><head></head><body>Standalone page</body></html>'
    expect(uiDisplayDocument(page)).toBe(page)
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
