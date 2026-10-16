// Adds English entries to src/shared/i18n/en.ts.
// Usage: node scripts/i18n-add.mjs '{"中文":"English", ...}'
import { readFileSync, writeFileSync } from 'node:fs'
const file = new URL('../src/shared/i18n/en.ts', import.meta.url)
const add = JSON.parse(process.argv[2])
let src = readFileSync(file, 'utf8').trimEnd()
if (!src.endsWith('}')) throw new Error('unexpected en.ts shape')
const lines = Object.entries(add)
  .filter(([k]) => !src.includes(JSON.stringify(k) + ':'))
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
src = src.slice(0, -1).trimEnd() + '\n' + lines.join('\n') + '\n}\n'
writeFileSync(file, src)
console.log(`added ${lines.length}`)
