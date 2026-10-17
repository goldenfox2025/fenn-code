import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ModelUsage, UsageSummary } from '@shared/model'
import { formatTokens } from '@shared/usage'
import { localeTag } from '@shared/i18n'
import { api, useApp } from '../store'
import { lang, t } from '../i18n'

const GAP = 3
const MAX_WEEKS = 53
/** The smallest square that still reads as one; below it, fewer weeks are shown instead. */
const MIN_CELL = 9
const MAX_CELL = 12
/** Room for the weekday names on the left. */
const LABELS = 22
/** Models listed by name; the rest are summed into one line. */
const TOP_MODELS = 4

const locale = localeTag(lang)
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * The home page's usage card: the tokens used each day for the past year, as on a GitHub
 * profile (one square a day, weeks as columns, Monday on top, darker for busier days), with
 * a few figures above and the most used models below. Hidden until there is usage to show.
 */
export function UsageHeatmap() {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  useEffect(() => {
    let live = true
    void api()
      .usageCalendar()
      .then((u) => live && setUsage(u), () => live && setUsage({ days: [], models: [] }))
    return () => {
      live = false
    }
  }, [])

  // Squares sized to fill the card: a year when it fits, fewer weeks when the window is narrow.
  const box = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ weeks: MAX_WEEKS, cell: 10 })
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
  }, [usage === null])

  const { weeks, cell } = fit
  const grid = useMemo(() => {
    const byDay = new Map((usage?.days ?? []).map((d) => [d.day, d]))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // The last column is this week; Monday starts each column.
    const start = new Date(today)
    start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7)
    const cols = Array.from({ length: weeks }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const date = new Date(start)
        date.setDate(start.getDate() + w * 7 + d)
        return { date, use: byDay.get(key(date)), future: date > today }
      })
    )
    const past = cols.flat().filter((c) => !c.future)
    const shown = past.filter((c) => c.use)
    // The longest run of days in a row with usage.
    let run = 0
    let streak = 0
    for (const c of past) {
      run = c.use ? run + 1 : 0
      streak = Math.max(streak, run)
    }
    // Month names over the first column that starts in a new month, skipping one too close to the last.
    let last = -9
    const months = cols.map((col, i) => {
      const starts = i === 0 || col[0].date.getMonth() !== cols[i - 1][0].date.getMonth()
      if (!starts || i - last < 3 || i > weeks - 3) return null
      if (i === 0 && cols[2][0].date.getMonth() !== col[0].date.getMonth()) return null
      last = i
      return col[0].date
    })
    return {
      cols,
      months,
      max: Math.max(0, ...shown.map((c) => c.use!.tokens)),
      total: shown.reduce((n, c) => n + c.use!.tokens, 0),
      activeDays: shown.length,
      streak,
      today: key(today)
    }
  }, [usage, weeks])

  if (!usage?.days.length) return <div ref={box} className="usage-card-box" />
  // Square roots spread the levels: a few heavy days would otherwise leave the rest all the palest shade.
  const level = (tokens: number) => Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(tokens / grid.max))))
  const monthName = new Intl.DateTimeFormat(locale, { month: 'short' })
  const dayName = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' })
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  const step = cell + GAP
  const span = weeks >= MAX_WEEKS ? t('过去一年') : t('过去 {0} 周', weeks)

  return (
    <div ref={box} className="usage-card-box">
      <section className="usage-card" aria-label={t('用量')}>
        <div className="usage-stats">
          <Stat value={formatTokens(grid.total)} label={t('{0}的 tokens', span)} />
          <Stat value={String(grid.activeDays)} label={t('有用量的天数')} />
          <Stat value={t('{0} 天', grid.streak)} label={t('最长连续')} />
        </div>
        <div className="heatmap" style={{ '--heat-cell': `${cell}px`, '--heat-gap': `${GAP}px` } as CSSProperties}>
          <div className="heatmap-months">
            {grid.months.map((m, i) =>
              m ? (
                <span key={i} style={{ left: LABELS + i * step }}>
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
        {usage.models.length > 0 && <TopModels models={usage.models} />}
      </section>
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="usage-stat">
      <div className="usage-stat-value">{value}</div>
      <div className="usage-stat-label">{label}</div>
    </div>
  )
}

/** The most used models by tokens, each with its share as a bar; the rest summed into one line. */
function TopModels({ models }: { models: ModelUsage[] }) {
  const backends = useApp((s) => s.backends)
  const catalogs = useApp((s) => s.settings.backendModels)
  const total = models.reduce((n, m) => n + m.tokens, 0)
  const backendName = (id: string) => backends.find((b) => b.id === id)?.name ?? id
  const rows = models.slice(0, TOP_MODELS).map((m) => {
    const name = m.name ?? catalogs?.[m.backendId]?.models.find((x) => x.id === m.id)?.name ?? m.id
    return { key: `${m.backendId}/${m.id ?? ''}`, name: name ?? backendName(m.backendId), via: name ? backendName(m.backendId) : undefined, tokens: m.tokens, replies: m.replies }
  })
  const rest = models.slice(TOP_MODELS)
  if (rest.length)
    rows.push({ key: 'rest', name: t('其他 {0} 个', rest.length), via: undefined, tokens: rest.reduce((n, m) => n + m.tokens, 0), replies: rest.reduce((n, m) => n + m.replies, 0) })
  const share = (n: number) => (total ? n / total : 0)
  return (
    <div className="top-models">
      <div className="top-models-head">{t('常用模型')}</div>
      {rows.map((r) => (
        <div key={r.key} className="top-model" data-tip={t('{0} tokens · {1} 条回复', formatTokens(r.tokens), r.replies)}>
          <span className="top-model-name">
            {r.name}
            {r.via && <span className="top-model-via">{r.via}</span>}
          </span>
          <span className="top-model-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(2, share(r.tokens) * 100)}%` }} />
          </span>
          <span className="top-model-share">{Math.round(share(r.tokens) * 100)}%</span>
        </div>
      ))}
    </div>
  )
}
