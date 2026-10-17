import { join } from 'node:path'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM script without types
import { rawValues, readStyles } from '../scripts/style-check.mjs'

const css = join(__dirname, '../src/renderer/src/styles.css')
/**
 * Raw spacing, radius and color values still left in styles.css from before
 * the tokens. The number only ever goes down: new CSS uses tokens.css.
 */
const LEGACY = 217

/** Rules that make up a turn of the conversation; these must use tokens only. */
const TURN = /\.(turn|working-|steps|step-|placed-line|thread-card|tooltip|transcript|msg-actions|md)\b/

describe('styles use the design tokens', () => {
  it('adds no raw px spacing, radius or colors outside tokens.css', () => {
    const found: { rule: string; text: string }[] = rawValues(css)
    expect(found.length, 'use the tokens in tokens.css instead of raw values').toBeLessThanOrEqual(LEGACY)
  })

  it('builds a turn of the conversation from tokens alone', () => {
    const found: { rule: string; text: string }[] = rawValues(css)
    expect(found.filter((f) => TURN.test(f.rule) && !f.rule.includes('data-theme')).map((f) => `${f.rule} { ${f.text} }`)).toEqual([])
  })

  it('times every transition and one-shot animation with the motion tokens', () => {
    const raw: string[] = []
    postcss.parse(readStyles(css)).walkDecls(/^(transition|animation)(-duration|-delay)?$/, (d) => {
      // Loops (spinners, the working dots and their stagger) keep their own rhythm; a search hit's flash lingers on purpose.
      if (d.prop === 'animation-delay' || (d.prop.startsWith('animation') && /\binfinite\b|^flash\b/.test(d.value))) return
      // Reduced motion stops everything at once.
      const media = d.parent?.parent
      if (media?.type === 'atrule' && /reduced-motion/.test((media as postcss.AtRule).params)) return
      if (/(^|[\s,(])\d*\.?\d+m?s\b/.test(d.value.replace(/var\([^)]*\)/g, ''))) raw.push(`${d.prop}: ${d.value}`)
    })
    expect(raw, 'use --dur-1/2/3 and --ease from tokens.css').toEqual([])
  })
})
