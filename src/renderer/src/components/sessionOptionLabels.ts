import type { SessionOption } from '@shared/contract'
import { lang, t } from '../i18n'

export function optionLabel(o: SessionOption): string {
  if (o.category === 'mode') return t('权限模式')
  if (o.category === 'thought_level') return t('思考强度')
  return o.name
}

/** Common English names agents give their modes and levels, in Chinese when the UI is. */
const CHOICE_ZH: Record<string, string> = {
  default: '每次询问', // i18n-ignore
  'accept edits': '自动接受编辑', // i18n-ignore
  auto: '自动判断', // i18n-ignore
  "don't ask": '不询问，直接拒绝', // i18n-ignore
  'bypass permissions': '全部允许', // i18n-ignore
  plan: '只做计划', // i18n-ignore
  'plan mode': '只做计划', // i18n-ignore
  minimal: '最低', // i18n-ignore
  none: '不启用推理', // i18n-ignore
  low: '低', // i18n-ignore
  medium: '中', // i18n-ignore
  high: '高', // i18n-ignore
  max: '最高', // i18n-ignore
  xhigh: '很高', // i18n-ignore
  'extra high': '很高', 'very high': '很高', 'x high': '很高', ultra: '极高', // i18n-ignore
  'very low': '很低', off: '关闭', think: '思考', 'think hard': '深入思考' // i18n-ignore
}
function zhOf(text: string): string | undefined {
  // "Extra High", "extra-high", "xhigh effort" and "High (reasoning)" all read the same.
  const key = text.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s*(effort|reasoning|\(reasoning\))$/, '').trim()
  return CHOICE_ZH[key] ?? CHOICE_ZH[key.replace(/\s+/g, '')]
}

/** A choice's label: by its value first (stable across agents), then by its name. */
export function choiceLabel(name: string, value?: string): string {
  if (lang !== 'zh') return name
  const m = name.match(/^(.*?)(\s*\(default\))?$/i)
  const zh = (value !== undefined ? zhOf(value) : undefined) ?? zhOf(m?.[1] ?? name)
  return zh ? zh + (m?.[2] ? '（默认）' : '') : name // i18n-ignore
}

/** How much thinking a level means, from its value or name; undefined when it doesn't say. */
export function effortRank(c: { value: string; name: string }): number | undefined {
  for (const raw of [c.value, c.name]) {
    const k = raw.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s*\(default\)$/, '').replace(/\s*(effort|reasoning|thinking)$/, '').trim()
    const flat = k.replace(/\s+/g, '')
    if (/^(none|off|no|disabled)$/.test(flat)) return 0
    if (/^(minimal|min|lowest)$/.test(flat)) return 1
    if (/^(verylow|xlow)$/.test(flat)) return 1.5
    if (/^(low|light|fast)$/.test(flat)) return 2
    if (/^(medium|med|mid|default|normal|balanced|auto|think)$/.test(flat)) return 3
    if (/^(high|hard|deep|thinkhard)$/.test(flat)) return 4
    if (/^(veryhigh|extrahigh|xhigh|higher|ultrathink|megathink)$/.test(flat)) return 5
    if (/^(max|maximum|highest|ultra|xxhigh)$/.test(flat)) return 6
  }
  return undefined
}

/**
 * The levels from fastest to smartest, whatever order the agent listed them in.
 * Known levels are sorted by rank; unknown ones keep their place relative to
 * their neighbours. If too few are recognised to sort, the agent's order is
 * kept, turned around when the recognised ones run from high to low.
 */
export function effortStops<C extends { value: string; name: string }>(choices: C[]): C[] {
  const ranks = choices.map(effortRank)
  const known = ranks.filter((r): r is number => r !== undefined)
  if (known.length === choices.length) return choices.map((c, i) => [c, ranks[i]!] as const).sort((a, b) => a[1] - b[1]).map(([c]) => c)
  if (known.length >= 2) {
    const firstKnown = known[0]
    const lastKnown = known[known.length - 1]
    if (firstKnown > lastKnown) return [...choices].reverse()
  }
  return choices
}

/**
 * A thinking level's label. Levels the table doesn't know never show raw English
 * in the Chinese UI: they read as 第 n 档 instead.
 */
export function effortLabel(o: SessionOption, i: number): string {
  const c = effortStops(o.choices)[i]
  if (!c) return ''
  const label = choiceLabel(c.name, c.value)
  if (lang !== 'zh' || label !== c.name || /[\u3400-\u9fff]/.test(label)) return label
  return t('第 {0} 档', i + 1)
}

