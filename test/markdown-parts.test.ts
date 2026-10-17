import { describe, expect, it } from 'vitest'
import { markdownParts } from '../src/renderer/src/markdownParts'

describe('long replies are parsed piece by piece', () => {
  const para = (n: number) => `第 ${n} 段。` + '内容'.repeat(400)
  it('leaves short text whole', () => {
    expect(markdownParts('a\n\nb')).toEqual(['a\n\nb'])
  })
  it('splits at blank lines, and the pieces join back to the same text', () => {
    const text = [para(1), para(2), para(3)].join('\n\n')
    const parts = markdownParts(text)
    expect(parts).toHaveLength(3)
    expect(parts.join('\n')).toBe(text)
  })
  it('never splits inside a code fence or before an indented continuation', () => {
    const text = [para(1), '```js\nconst a = 1\n\nconst b = 2\n```', '- item\n\n  more of the item', para(2)].join('\n\n')
    const parts = markdownParts(text)
    expect(parts.join('\n')).toBe(text)
    expect(parts.some((p) => p.includes('const a = 1') && p.includes('const b = 2'))).toBe(true)
    expect(parts.some((p) => p.includes('- item') && p.includes('more of the item'))).toBe(true)
  })
  it('keeps a list whose items are separated by blank lines in one piece', () => {
    const text = [para(1), '- 要点 A', '- 要点 B', '1. 第一', '2. 第二', para(2)].join('\n\n')
    const parts = markdownParts(text)
    expect(parts.join('\n')).toBe(text)
    expect(parts.some((p) => p.includes('- 要点 A') && p.includes('- 要点 B') && p.includes('2. 第二'))).toBe(true)
  })
})
