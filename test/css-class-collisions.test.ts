import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A modifier class on a component (`.panel.floating`) must not share its name
 * with a class that is styled on its own (`.overlay`), or the element picks up
 * both: the thread panel once got the modal backdrop's colour this way.
 */
const ALLOWED = new Set([
  'mono', // the monospace utility, meant to combine
  'mac', // the platform class on the window
  'select-btn', // a footer chip that is also a select button
  'chat-row', // a list row that is also a chat row
  'mention-menu' // a menu that is also the @ menu
])

function selectors(): string[] {
  const css = readFileSync('src/renderer/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s))
}

const classesOf = (compound: string) =>
  (compound.replace(/^:root(\[[^\]]*\])*/, '').replace(/:[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '').match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1))

describe('CSS class names', () => {
  it('no modifier class collides with a class styled on its own', () => {
    const standalone = new Set<string>()
    const modifiers = new Map<string, string>()
    for (const s of selectors()) {
      const compounds = s.split(/\s*[\s>+~]\s*/).filter((c) => c && !/^:root(\[[^\]]*\])*$/.test(c))
      const first = classesOf(compounds[0] ?? '')
      if (first.length === 1 && compounds[0].replace(/^:root(\[[^\]]*\])*/, '').startsWith('.')) standalone.add(first[0])
      for (const c of compounds) for (const m of classesOf(c).slice(1)) if (!modifiers.has(m)) modifiers.set(m, s)
    }
    const clashes = [...modifiers].filter(([m]) => standalone.has(m) && !ALLOWED.has(m)).map(([m, s]) => `.${m} in "${s}"`)
    expect(clashes).toEqual([])
  })
})
