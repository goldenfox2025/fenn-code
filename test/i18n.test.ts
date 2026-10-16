import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const src = join(__dirname, '../src')
const renderer = join(src, 'renderer/src')
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })
}
const KEY = /\b(?:t|tk)\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"')

describe('translations', () => {
  it('every string marked with t() or tk() has an English translation', async () => {
    const { en } = await import('../src/shared/i18n/en')
    const missing: string[] = []
    for (const f of files(src)) {
      if (f.includes(join('shared', 'i18n'))) continue
      for (const m of readFileSync(f, 'utf8').matchAll(KEY)) {
        const key = unescape(m[1] ?? m[2])
        if (/[一-鿿]/.test(key) && !(key in en)) missing.push(`${f.slice(src.length + 1)}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  // The main process also holds Chinese prompts and tool texts meant for the
  // agent (it answers in the user's language), so only the UI is checked here.
  it('no Chinese text in the UI is left outside t()', () => {
    const bare: string[] = []
    for (const f of files(renderer)) {
      const code = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !l.includes('i18n-ignore'))
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replace(KEY, '')
      for (const line of code.split('\n')) if (/[一-鿿]/.test(line)) bare.push(`${f.slice(renderer.length + 1)}: ${line.trim()}`)
    }
    expect(bare).toEqual([])
  })
})

describe('t()', () => {
  it('fills arguments and picks singular or plural words', async () => {
    const { setLang, t } = await import('../src/shared/i18n')
    setLang('en')
    try {
      expect(t('读取了 {0} 个文件', 1)).toBe('Read 1 file')
      expect(t('读取了 {0} 个文件', 3)).toBe('Read 3 files')
      expect(t('没有这个选项：{0}', 'x')).toBe('No such option: x')
    } finally {
      setLang('zh')
    }
    expect(t('读取了 {0} 个文件', 3)).toBe('读取了 3 个文件')
  })
})
