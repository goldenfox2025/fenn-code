import type { Schedule } from '../../shared/model'
import { localeTag, t, tk } from '../../shared/i18n'
import { nextCron } from './schedule'

/** Validation and display have no dependency on either host's orchestration. */
export function parseScheduleArgs(a: Record<string, unknown>, now = Date.now()): Schedule {
  switch (String(a.schedule ?? '')) {
    case 'once': {
      const at = Date.parse(String(a.at ?? ''))
      if (!Number.isFinite(at)) throw new Error('once 需要 at（ISO 8601 时间）')
      if (at < now - 60_000) throw new Error('at 已经过去了')
      return { kind: 'once', at }
    }
    case 'interval': {
      const minutes = Math.round(Number(a.minutes))
      if (!Number.isFinite(minutes) || minutes < 5) throw new Error('interval 需要 minutes，至少 5')
      return { kind: 'interval', minutes }
    }
    case 'daily':
    case 'weekly': {
      const time = String(a.time ?? '').trim()
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('需要 time，格式 HH:MM')
      const hhmm = time.padStart(5, '0')
      if (a.schedule === 'daily') return { kind: 'daily', time: hhmm }
      const days = (Array.isArray(a.weekdays) ? a.weekdays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      if (!days.length) throw new Error('weekly 需要 weekdays，例如 [1, 3, 5]')
      return { kind: 'daily', time: hhmm, weekdays: [...new Set(days)].sort() }
    }
    case 'cron': {
      const expr = String(a.cron ?? '').trim()
      if (nextCron(expr, now) === undefined) throw new Error('cron 表达式无效')
      return { kind: 'cron', expr }
    }
    default: throw new Error('schedule 只能是 once、interval、daily、weekly、cron')
  }
}
const WEEKDAYS = [tk('周日'), tk('周一'), tk('周二'), tk('周三'), tk('周四'), tk('周五'), tk('周六')]
export function scheduleText(s: Schedule): string {
  switch (s.kind) {
    case 'once': return t('一次，{0}', new Date(s.at).toLocaleString(localeTag(), { hour12: false }))
    case 'interval': return s.minutes % 60 === 0 ? t('每 {0} 小时', s.minutes / 60) : t('每 {0} 分钟', s.minutes)
    case 'daily': return s.weekdays?.length && s.weekdays.length < 7
      ? t('每{0} {1}', s.weekdays.map((d) => t(WEEKDAYS[d])).join(t('、')), s.time) : t('每天 {0}', s.time)
    case 'cron': return `cron ${s.expr}`
  }
}
