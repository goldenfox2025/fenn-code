/** How much thinking a level means, from its value or name; undefined when it doesn't say. */
export function effortRankOf(c: { value: string; name: string }): number | undefined {
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
