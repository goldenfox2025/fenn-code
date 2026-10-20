import { describe, expect, it } from 'vitest'
import { uiDocument } from '../src/main/core/uiDocument'

describe('embedded conversation UI documents', () => {
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
