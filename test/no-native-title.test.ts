import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.tsx') ? [p] : []
  })

/** Every `title=` on an HTML element in the renderer, as file:line. */
function nativeTitles(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const found: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'JSXAttribute' && n.name?.name === 'title') return
    if (n.type === 'JSXOpeningElement' && n.name.type === 'JSXIdentifier' && /^[a-z]/.test(n.name.name) && !['svg', 'iframe'].includes(n.name.name))
      for (const a of n.attributes) if (a.type === 'JSXAttribute' && a.name?.name === 'title') found.push(`${file}:${a.loc.start.line}`)
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (k === 'loc' || k === 'start' || k === 'end') continue
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') walk(v)
    }
  }
  walk(parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] }).program)
  return found
}

describe('tooltips', () => {
  it('uses the app tooltip (data-tip), never the native title, which the system draws boxy and clipped', () => {
    const found = files(join(__dirname, '../src/renderer/src')).flatMap(nativeTitles)
    expect(found).toEqual([])
  })
})
