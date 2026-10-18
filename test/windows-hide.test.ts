import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = join(__dirname, '../src/main')
const CALLS = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/g
/** The one window opened on purpose: the terminal the user signs in with (it says windowsHide: false). */
const VISIBLE = new Set(['backends/terminal.ts'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : []
  })
}

/** The text of a call from its opening parenthesis to the matching close. */
function callAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

describe('no console window ever flashes on Windows', () => {
  it('every child process the app starts passes windowsHide', () => {
    const missing: string[] = []
    let seen = 0
    for (const file of files(MAIN)) {
      const src = readFileSync(file, 'utf8')
      if (!/child_process/.test(src)) continue
      const rel = relative(MAIN, file).split('\\').join('/')
      for (const m of src.matchAll(CALLS)) {
        // RegExp.exec and friends are not process calls.
        if (src[m.index! - 1] === '.') continue
        seen++
        const call = callAt(src, m.index! + m[0].length - 1)
        const hidden = /windowsHide:\s*true/.test(call) || (VISIBLE.has(rel) && /windowsHide:\s*false/.test(call))
        if (!hidden) missing.push(`${rel}:${src.slice(0, m.index).split('\n').length} ${m[1]}`)
      }
    }
    expect(seen).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })
})
