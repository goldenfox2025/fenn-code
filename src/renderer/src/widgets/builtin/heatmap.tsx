import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { formatTokens } from '@shared/usage'
import { localeTag } from '@shared/i18n'
import { lang, t } from '../../i18n'
import type { Widget } from '../registry'
import { WidgetCard } from '../WidgetCard'
import { dayKey, today as midnight, useUsageSummary } from '../usage'

const GAP = 3
const MAX_WEEKS = 53
/** The smallest square that still reads as one; below it, fewer weeks are shown instead. */
const MIN_CELL = 9
const MAX_CELL = 12
/** Room for the weekday names on the left. */
const LABELS = 22

const locale = localeTag(lang)

/**
 * The tokens used each day, as on a GitHub profile: one square a day, weeks as columns,
 * Monday on top, darker for busier days. A year when it fits, fewer weeks when narrow.
 */
function Heatmap() {
  const usage = useUsageSummary()
  const box = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ weeks: MAX_WEEKS, cell: 10 })
  const ready = !!usage?.days.length
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const room = el.clientWidth - LABELS
      const cell = Math.floor((room + GAP) / MAX_WEEKS) - GAP
      if (cell >= MIN_CELL) setFit({ weeks: MAX_WEEKS, cell: Math.min(cell, MAX_CELL) })
      else setFit({ weeks: Math.max(8, Math.floor((room + GAP) / (MIN_CELL + GAP))), cell: MIN_CELL })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])

  const { weeks, cell } = fit
  const grid = useMemo(() => {
    const byDay = new Map((usage?.days ?? []).map((d) => [d.day, d]))
    const today = midnight()
    // The last column is this week; Monday starts each column.
    const start = new Date(today)
    start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
    const cols = Array.from({ length: weeks }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const date = new Date(start)
        date.setDate(start.getDate() + w * 7 + d)
        return { date, use: byDay.get(dayKey(date)), future: date > today }
      })
    )
    // Month names over the first column that starts in a new month, skipping one too close to the last.
    let last = -9
    const months = cols.map((col, i) => {
      const starts = i === 0 || col[0].date.getMonth() !== cols[i - 1][0].date.getMonth()
      if (!starts || i - last < 3) return null
      if (i === 0 && cols[2][0].date.getMonth() !== col[0].date.getMonth()) return null
      last = i
      return col[0].date
    })
    const max = Math.max(0, ...cols.flat().map((c) => (c.future ? 0 : c.use?.tokens ?? 0)))
    return { cols, months, max, today: dayKey(today) }
  }, [usage, weeks])

  if (!ready) return null
  // Square roots spread the levels: a few heavy days would otherwise leave the rest all the palest shade.
  const level = (tokens: number) => Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(tokens / grid.max))))
  const monthName = new Intl.DateTimeFormat(locale, { month: 'short' })
  const dayName = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' })
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  const step = cell + GAP

  return (
    <WidgetCard title={weeks >= MAX_WEEKS ? t('每日用量') : t('每日用量 · 过去 {0} 周', weeks)}>
      <div ref={box} className="heatmap" style={{ '--heat-cell': `${cell}px`, '--heat-gap': `${GAP}px` } as CSSProperties}>
        <div className="heatmap-months">
          {grid.months.map((m, i) =>
            m ? (
              // The month that starts in the last columns ends at the right edge rather than past it.
              <span key={i} style={i > weeks - 3 ? { right: 0 } : { left: LABELS + i * step }}>
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
                const k = dayKey(date)
                if (future) return <i key={k} className="heat-cell future" />
                const tip = use
                  ? t('{0}：{1} tokens · {2} 条回复', dayName.format(date), formatTokens(use.tokens), use.replies)
                  : t('{0}：没有用量', dayName.format(date))
                return <i key={k} className={'heat-cell l' + (use ? level(use.tokens) : 0) + (k === grid.today ? ' today' : '')} data-tip={tip} />
              })}
            </div>
          ))}
        </div>
        <div className="heatmap-legend" aria-hidden="true">
          {t('少')}
          {[0, 1, 2, 3, 4].map((l) => (
            <i key={l} className={'heat-cell l' + l} />
          ))}
          {t('多')}
        </div>
      </div>
    </WidgetCard>
  )
}

export default { id: 'usage-heatmap', title: t('每日用量'), size: 'wide', order: 10, Component: Heatmap } satisfies Widget
