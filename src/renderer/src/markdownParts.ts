/** Long text this size and up is parsed piece by piece (a long reply stays smooth while it streams). */
const SPLIT_AT = 1500

/**
 * Splits markdown at blank lines between top-level blocks: never inside a code
 * fence, and not before an indented line (a list item or code that continues).
 */
export function markdownParts(text: string): string[] {
  if (text.length < SPLIT_AT) return [text]
  const lines = text.split('\n')
  const parts: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  // The last line with text: a list item there and on the next line keeps one list.
  let lastText = ''
  const item = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const f = /^\s*(`{3,}|~{3,})/.exec(l)?.[1]
    if (f) fence = fence ? (f[0] === fence[0] && f.length >= fence.length ? null : fence) : f
    cur.push(l)
    if (l.trim()) lastText = l
    const next = lines[i + 1]
    if (!fence && l.trim() === '' && next !== undefined && next.trim() !== '' && !/^\s/.test(next) && !/^\s*[|]/.test(next) && !(item(lastText) && item(next))) {
      parts.push(cur.join('\n'))
      cur = []
    }
  }
  if (cur.length) parts.push(cur.join('\n'))
  return parts
}
