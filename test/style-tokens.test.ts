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
const LEGACY = 99

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

  it('takes every corner radius from the shared radius scale', () => {
    const offScale: string[] = []
    postcss.parse(readStyles(css)).walkDecls(/^border(?:-\w+)*-radius$/, (d) => {
      const value = d.value.replace(/var\(--radius[-\w]*\)/g, '').replace(/\b(?:0|inherit)\b/g, '').trim()
      if (value) offScale.push(`${(d.parent as postcss.Rule).selector}: ${d.value}`)
    })
    expect(offScale).toEqual([])
  })

  it('times every transition and one-shot animation with the motion tokens', () => {
    const raw: string[] = []
    postcss.parse(readStyles(css)).walkDecls(/^(transition|animation)(-duration|-delay)?$/, (d) => {
      // Loops (spinners, the working dots, shimmer) take theirs from tokens too: --dur-spin, --dur-pulse, --dur-shimmer, --stagger.
      // Reduced motion stops everything at once.
      const media = d.parent?.parent
      if (media?.type === 'atrule' && /reduced-motion/.test((media as postcss.AtRule).params)) return
      if (/(^|[\s,(])\d*\.?\d+m?s\b/.test(d.value.replace(/var\([^)]*\)/g, ''))) raw.push(`${d.prop}: ${d.value}`)
    })
    expect(raw, 'use the --dur-* and --ease tokens from tokens.css').toEqual([])
  })
})
