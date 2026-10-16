import type { Schedule } from '../../shared/model'

/**
 * Next time (ms) strictly after `from` that the schedule fires, or undefined if never again.
 * `slot` is the time the last run was scheduled for: intervals count from it,
 * on whole minutes, so a slow run doesn't push every later run back.
 */
export function nextRun(s: Schedule, from: number, lastRunAt?: number, slot?: number): number | undefined {
  switch (s.kind) {
    case 'once':
      // Done once it ran at or after its time; an early manual run doesn't count.
      return lastRunAt !== undefined && lastRunAt >= s.at ? undefined : s.at
    case 'interval': {
      const step = Math.max(1, s.minutes) * 60_000
      let next = Math.ceil(((slot ?? lastRunAt ?? from) + step) / 60_000) * 60_000
      // Missed slots (app closed, a long run) are skipped, not replayed.
      if (next <= from) next += Math.ceil((from - next + 1) / step) * step
      return next
    }
    case 'daily': {
      const [h, m] = s.time.split(':').map(Number)
      const d = new Date(from)
      d.setSeconds(0, 0)
      d.setHours(h, m)
      for (let i = 0; i < 8; i++) {
        if (d.getTime() > from && (!s.weekdays?.length || s.weekdays.includes(d.getDay()))) return d.getTime()
        d.setDate(d.getDate() + 1)
        d.setHours(h, m)
      }
      return undefined
    }
    case 'cron':
      return nextCron(s.expr, from)
  }
}

/** Standard 5-field cron (minute hour day-of-month month day-of-week), local time. */
export function nextCron(expr: string, from: number): number | undefined {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) throw new Error('cron 表达式需要 5 段：分 时 日 月 周')
  const [min, hour, dom, mon, dow] = [
    parseField(f[0], 0, 59),
    parseField(f[1], 0, 23),
    parseField(f[2], 1, 31),
    parseField(f[3], 1, 12),
    parseField(f[4].replace(/\b7\b/g, '0'), 0, 6)
  ]
  const domAny = f[2] === '*'
  const dowAny = f[4] === '*'
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const limit = from + 366 * 86400_000 * 2
  while (d.getTime() < limit) {
    if (!mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0)
      continue
    }
    // Vixie cron: if both day fields are restricted, either may match.
    const dayOk = domAny && dowAny ? true : domAny ? dow.has(d.getDay()) : dowAny ? dom.has(d.getDate()) : dom.has(d.getDate()) || dow.has(d.getDay())
    if (!dayOk) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0)
      continue
    }
    if (!hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0)
      continue
    }
    if (!min.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1)
      continue
    }
    return d.getTime()
  }
  return undefined
}

function parseField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/')
    const step = stepStr ? parseInt(stepStr, 10) : 1
    let a = lo
    let b = hi
    if (range !== '*') {
      const [x, y] = range.split('-').map((n) => parseInt(n, 10))
      if (Number.isNaN(x)) throw new Error(`无法解析 cron 字段：${field}`)
      a = x
      b = y ?? (stepStr ? hi : x)
    }
    if (a < lo || b > hi || step < 1) throw new Error(`cron 字段超出范围：${field}`)
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out
}
