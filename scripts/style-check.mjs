// Finds raw spacing/radius px values and raw colors in component CSS. Everything
// visual comes from src/renderer/src/tokens.css; see test/style-tokens.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import postcss from 'postcss'

const SPACING = /^(margin|padding|gap|row-gap|column-gap|border-radius|inset|top|right|bottom|left)(-|$)|^(margin|padding)-(block|inline)/
// Hairlines (0.5px, 1px) are borders' business and stay as they are.
const RAW_PX = /(^|[\s(,])-?(?!(?:0\.5|1)px)\d*\.?\d+px\b/
const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i

/** A stylesheet with its local @imports inlined, in order: the CSS the app really gets. */
export function readStyles(file) {
  return readFileSync(file, 'utf8').replace(/^@import\s+['"](\.[^'"]+)['"];?\s*$/gm, (_, rel) => readStyles(resolve(dirname(file), rel)))
}

/** One line per raw value: `selector { prop: value }`. */
export function rawValues(file) {
  const out = []
  postcss.parse(readStyles(file)).walkDecls((d) => {
    if (d.prop.startsWith('--')) return
    const rule = d.parent?.type === 'rule' ? d.parent.selector : d.parent?.parent?.selector ?? ''
    if (d.parent?.parent?.type === 'atrule' && /keyframes/.test(d.parent.parent.name)) return
    const v = d.value.replace(/var\([^)]*\)/g, '')
    if (SPACING.test(d.prop) && RAW_PX.test(v)) out.push({ rule, text: `${d.prop}: ${d.value}`, kind: 'px' })
    if (RAW_COLOR.test(v)) out.push({ rule, text: `${d.prop}: ${d.value}`, kind: 'color' })
  })
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = rawValues(process.argv[2] ?? 'src/renderer/src/styles.css')
  for (const f of found) console.log(`${f.kind}\t${f.rule.replace(/\s+/g, ' ')} { ${f.text} }`)
  console.log(`${found.length} raw values`)
}
