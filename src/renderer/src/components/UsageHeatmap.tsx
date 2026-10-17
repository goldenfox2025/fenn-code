import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UsageDay } from '@shared/model'
import { formatTokens } from '@shared/usage'
import { localeTag } from '@shared/i18n'
import { api } from '../store'
import { lang, t } from '../i18n'

const CELL = 11
const GAP = 3
const STEP = CELL + GAP
const MAX_WEEKS = 53
/** Room for the weekday names on the left. */
const LABELS = 22

const locale = localeTag(lang)
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * The tokens used each day, a year at a time, as on a GitHub profile: one square a day,
 * weeks as columns (Monday on top), darker for busier days. Hidden until there is something to show.
 */
export function UsageHeatmap() {
  const [days, setDays] = useState<UsageDay[] | null>(null)
  useEffect(() => {
    let live = true
    void api()
      .usageCalendar()
      .then((d) => live && setDays(d), () => live && setDays([]))
    return () => {
      live = false
    }
  }, [])

  // As many weeks as fit, up to a year.
  const box = useRef<HTMLDivElement>(null)
  const [weeks, setWeeks] = useState(MAX_WEEKS)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setWeeks(Math.max(8, Math.min(MAX_WEEKS, Math.floor((el.clientWidth - LABELS + GAP) / STEP))))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [days === null])

  const grid = useMemo(() => {
    const byDay = new Map((days ?? []).map((d) => [d.day, d]))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // The last column is this week; Monday starts each column.
    const start = new Date(today)
    start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
    const cols: { date: Date; use?: UsageDay; future: boolean }[][] = []
    for (let w = 0; w < weeks; w++) {
      const col = []
      for (let d = 0; d < 7; d++) {
        const date = new Date(start)
        date.setDate(start.getDate() + w * 7 + d)
        col.push({ date, use: byDay.get(key(date)), future: date > today })
      }
      cols.push(col)
    }
    const shown = cols.flat().filter((c) => c.use)
    const max = Math.max(0, ...shown.map((c) => c.use!.tokens))
    const total = shown.reduce((n, c) => n + c.use!.tokens, 0)
    // Month names over the first column that starts in a new month, skipping one too close to the last (a cut-off first month).
    let last = -9
    const months = cols.map((col, i) => {
      const starts = i === 0 || col[0].date.getMonth() !== cols[i - 1][0].date.getMonth()
      if (!starts || i - last < 3 || i > weeks - 3) return null
      if (i === 0 && cols[2][0].date.getMonth() !== col[0].date.getMonth()) return null
      last = i
      return col[0].date
    })
    return { cols, max, total, activeDays: shown.length, months, today: key(today) }
  }, [days, weeks])

  if (days === null || !days.length) return <div ref={box} className="heatmap-box" />
  // Square roots spread the levels: a few heavy days would otherwise leave the rest all the palest shade.
  const level = (tokens: number) => Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(tokens / grid.max))))
  const monthName = new Intl.DateTimeFormat(locale, { month: 'short' })
  const dayName = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' })
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  const width = LABELS + weeks * STEP - GAP

  return (
    <div ref={box} className="heatmap-box">
      <section className="heatmap" style={{ width }} aria-label={t('每天的 token 用量')}>
        <header className="heatmap-head">
          <span>
            {t('{0} tokens', formatTokens(grid.total))}
            <span className="heatmap-note">{t('{0} 天有用量', grid.activeDays)}</span>
          </span>
          <span className="heatmap-legend" aria-hidden="true">
            {t('少')}
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} className={'heat-cell l' + l} />
            ))}
            {t('多')}
          </span>
        </header>
        <div className="heatmap-months">
          {grid.months.map((m, i) =>
            m ? (
              <span key={i} style={{ left: LABELS + i * STEP }}>
                {monthName.format(m)}
              </span>
            ) : null
          )}
        </div>
        <div className="heatmap-body">
          <div className="heatmap-days" aria-hidden="true">
            {grid.cols[0].map((c, d) => (
              <span key={d}>{d % 2 === 0 ? weekday.format(c.date) : ''}</span>
            ))}
          </div>
          {grid.cols.map((col, w) => (
            <div key={w} className="heatmap-week">
              {col.map(({ date, use, future }) => {
                const k = key(date)
                if (future) return <i key={k} className="heat-cell future" />
                const tip = use ? t('{0}：{1} tokens · {2} 条回复', dayName.format(date), formatTokens(use.tokens), use.replies) : t('{0}：没有用量', dayName.format(date))
                return <i key={k} className={'heat-cell l' + (use ? level(use.tokens) : 0) + (k === grid.today ? ' today' : '')} data-tip={tip} />
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
