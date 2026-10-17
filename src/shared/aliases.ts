import type { ModelInfo, SessionOption } from './contract'
import { effortRankOf } from './effortRank'

/**
 * Agents list stand-ins like "Default (recommended)" or "auto" next to real
 * models and levels. A menu shows only what the user would actually get: a
 * model alias becomes the model it stands for, or is left out when nobody can
 * say which one that is.
 */
const ALIAS_ID = /^(default|auto|recommended)$/i
const ALIAS_NAME = /^(default|auto)\b|\brecommended\b|^(默认|推荐|自动)/i // i18n-ignore

export const isAlias = (id: string, name = ''): boolean => ALIAS_ID.test(id.trim()) || ALIAS_NAME.test(name.trim())

/** The model an alias stands for: the one whose name its description gives (e.g. "Opus 5.5 · Most capable"). */
function standsFor(alias: ModelInfo, concrete: ModelInfo[]): ModelInfo | undefined {
  const text = (alias.description ?? '').toLowerCase()
  if (!text) return undefined
  const hits = concrete.filter((m) => text.includes(m.name.toLowerCase()) || text.split(/[\s·,(]+/).includes(m.id.toLowerCase()))
  return hits.sort((a, b) => b.name.length - a.name.length)[0]
}

export function resolveModelAliases(models: ModelInfo[], current?: string): { models: ModelInfo[]; current?: string } {
  const concrete = models.filter((m) => !isAlias(m.id, m.name))
  // An agent that offers only stand-ins keeps them: an empty menu helps nobody.
  if (!concrete.length || concrete.length === models.length) return { models, current }
  let now = current
  const kept: ModelInfo[] = []
  for (const m of models) {
    if (!isAlias(m.id, m.name)) {
      kept.push(m)
      continue
    }
    const real = standsFor(m, concrete)
    if (m.id === current) {
      // The current choice always reads as a real model; an alias nobody can resolve stays as it is.
      if (real) now = real.id
      else kept.push(m)
    }
  }
  return { models: kept, current: now }
}

/**
 * Thinking levels: a "Default" level means whatever the agent would pick, which
 * no menu can name. It is left out; a session sitting on it moves to the
 * recommended level (medium when offered, else the middle one), the same level
 * the agent itself recommends. The returned fixes say what to set on the agent.
 */
export function resolveOptionAliases(options: SessionOption[]): { options: SessionOption[]; fixes: { id: string; value: string }[] } {
  const fixes: { id: string; value: string }[] = []
  const out = options.map((o) => {
    if (o.category !== 'thought_level') return o
    const choices = o.choices.filter((c) => !isAlias(c.value, c.name))
    if (!choices.length || choices.length === o.choices.length) return o
    let current = o.current
    if (!choices.some((c) => c.value === current)) {
      const ranked = [...choices].sort((a, b) => (effortRankOf(a) ?? 0) - (effortRankOf(b) ?? 0))
      current = (choices.find((c) => c.value.toLowerCase() === 'medium') ?? ranked[Math.floor((ranked.length - 1) / 2)]).value
      fixes.push({ id: o.id, value: current })
    }
    return { ...o, current, choices }
  })
  return { options: out, fixes }
}
