import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FoxMark } from '../src/renderer/src/components/FoxMark'

const src = (p: string) => readFileSync(join(__dirname, '../src/renderer/src', p), 'utf8')

describe('the thinking fox mark', () => {
  it('lands every pixel of its 16×16 grid on whole screen pixels at each offered size', () => {
    for (const size of [16, 20, 24, 30, 32, 36, 40, 48] as const) {
      const html = renderToStaticMarkup(createElement(FoxMark, { size }))
      const [x, , w] = html.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number)
      const scale = size / w
      expect(Number.isInteger(scale), `size ${size}`).toBe(true)
      expect(Number.isInteger(-x * scale), `size ${size}`).toBe(true)
      expect(16 * scale - 2 * x * scale <= size, `size ${size}`).toBe(true)
    }
  })

  it('replaces the sparkle and the working dots wherever the app shows its mark', () => {
    expect(src('views/HomeView.tsx')).toMatch(/<FoxMark size=\{32\} className="logo"/)
    expect(src('views/HomeView.tsx')).not.toMatch(/<Sparkles size=\{30\}/)
    expect(src('components/Transcript.tsx')).toMatch(/<WorkingMark\b/)
    expect(src('components/WorkingMark.tsx')).toMatch(/<FoxMark thinking \/>/)
    expect(src('components/Transcript.tsx')).not.toMatch(/working-dots/)
    expect(src('components/Composer.tsx')).toMatch(/<FoxMark thinking \/>/)
    expect(src('components/Onboarding.tsx')).toMatch(/<FoxMark size=\{48\}/)
  })

  it('stops animating under reduced motion', () => {
    expect(src('styles/20-fox-mark.css')).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.fox-mark\.thinking path \{ animation: none; \}/)
  })
})
