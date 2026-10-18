import { useMemo } from 'react'
import { Check, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { boardWidgetKey, type BoardTone, type BoardWidget, type BoardWidgetBody } from '@shared/model'
import { Markdown } from '../components/Transcript'
import { confirmDialog } from '../components/Modal'
import type { MenuItem } from '../components/Menu'
import { api, toastError, useApp } from '../store'
import { routeFor } from '../routes'
import { relTime } from '../util'
import { describeSchedule } from '../views/Pages'
import { t } from '../i18n'
import { registerWidget } from './registry'
import { WidgetCard, WidgetStat } from './WidgetCard'

/**
 * The cards agents put on the home board (the home_board tool), as widgets:
 * each registers like any plugin's, and its data is drawn here, in the app's
 * look. Only an 'html' card shows a page of its own, in a sandboxed frame.
 */

const TONE: Record<BoardTone, string> = { good: t('正常'), warn: t('注意'), bad: t('异常') }

function Tone({ tone }: { tone?: BoardTone }) {
  return tone ? <span className={'board-tone ' + tone} role="img" aria-label={TONE[tone]} /> : null
}

function Body({ id, body }: { id: string; body: BoardWidgetBody }) {
  switch (body.kind) {
    case 'stat':
      return (
        <div className="board-stats">
          {body.items.map((i, n) => (
            <WidgetStat key={n} value={i.value} label={i.label} note={i.note} before={<Tone tone={i.tone} />} />
          ))}
        </div>
      )
    case 'list':
      return (
        <ul className="board-list">
          {body.items.map((i, n) => (
            <li key={n} className={i.done ? 'done' : undefined}>
              {i.done ? <Check size={14} className="board-check" /> : i.tone ? <Tone tone={i.tone} /> : <span className="board-bullet" />}
              <span className="board-list-text">{i.text}</span>
              {i.note && <span className="board-note">{i.note}</span>}
            </li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className="board-table-wrap">
          <table className="board-table">
            <thead>
              <tr>
                {body.columns.map((c, n) => (
                  <th key={n}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.rows.map((r, n) => (
                <tr key={n}>
                  {body.columns.map((_, k) => (
                    <td key={k}>{r[k] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'chart':
      return <Chart body={body} />
    case 'markdown':
      return (
        <div className="board-md">
          <Markdown text={body.text} />
        </div>
      )
    case 'html':
      return <Frame id={id} body={body} />
  }
}

/** Series take these in order, never cycled (at most four). */
const SERIES = ['var(--accent)', 'var(--green)', 'var(--amber)', 'var(--text-3)']
const W = 600
const H = 160

/** A small bar or line chart: one axis from zero, a legend when there are several series, each value on hover. */
function Chart({ body }: { body: Extract<BoardWidgetBody, { kind: 'chart' }> }) {
  const max = Math.max(...body.series.flatMap((s) => s.values), 0) || 1
  const min = Math.min(...body.series.flatMap((s) => s.values), 0)
  const span = max - min || 1
  const y = (v: number) => H - ((v - min) / span) * H
  const n = body.labels.length
  const slot = W / n
  const fmt = (v: number) => `${v.toLocaleString()}${body.unit ? ' ' + body.unit : ''}`
  const every = Math.ceil(n / 8)
  return (
    <div className="board-chart">
      {body.series.length > 1 && (
        <div className="board-legend">
          {body.series.map((s, i) => (
            <span key={i}>
              <i style={{ background: SERIES[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={body.series.map((s) => s.name).join(', ')}>
        <line className="board-axis" x1={0} x2={W} y1={y(0)} y2={y(0)} />
        {body.style === 'bar'
          ? body.series.map((s, si) =>
              s.values.map((v, i) => {
                // Thin bars: the group takes half its slot, centred, with a 2px gap between series.
                const bw = Math.max(2, Math.min(24, (slot * 0.5) / body.series.length - 2))
                const group = body.series.length * (bw + 2) - 2
                const x = i * slot + (slot - group) / 2 + si * (bw + 2)
                return (
                  <rect key={`${si}-${i}`} x={x} width={bw} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(0) - y(v)))} rx={2} fill={SERIES[si]} data-tip={`${body.labels[i]} · ${s.name}：${fmt(v)}`} />
                )
              })
            )
          : body.series.map((s, si) => (
              <g key={si}>
                <polyline fill="none" stroke={SERIES[si]} strokeWidth={2} vectorEffect="non-scaling-stroke" points={s.values.map((v, i) => `${i * slot + slot / 2},${y(v)}`).join(' ')} />
                {s.values.map((v, i) => (
                  <rect key={i} x={i * slot} width={slot} y={0} height={H} fill="transparent" data-tip={`${body.labels[i]} · ${s.name}：${fmt(v)}`} />
                ))}
              </g>
            ))}
      </svg>
      <div className="board-labels">
        {body.labels.map((l, i) => (
          <span key={i}>{i % every === 0 ? l : ''}</span>
        ))}
      </div>
    </div>
  )
}

/** The colors of the current look, handed to an html card so it can match the app. */
function themeQuery(): string {
  const css = getComputedStyle(document.documentElement)
  const vars = ['--text', '--text-2', '--text-3', '--bg', '--bg-elevated', '--border', '--accent', '--green', '--amber', '--red']
  return new URLSearchParams(vars.map((v) => [v.slice(2), css.getPropertyValue(v).trim()])).toString()
}

function Frame({ id, body }: { id: string; body: Extract<BoardWidgetBody, { kind: 'html' }> }) {
  const updatedAt = useApp((s) => s.boardWidgets.find((w) => w.id === id)?.updatedAt)
  const theme = useApp((s) => s.settings.theme)
  const query = useMemo(themeQuery, [theme])
  return <iframe className="board-frame" title={id} sandbox="allow-scripts" style={{ height: body.height ?? 240 }} src={`oc-page://board/${id}/${updatedAt}?${query}`} />
}

function BoardCard({ id }: { id: string }) {
  const w = useApp((s) => s.boardWidgets.find((x) => x.id === id))
  const source = useApp((s) => s.conversations.find((c) => c.id === w?.createdBy))
  const routine = useApp((s) => s.routines.find((r) => r.id === w?.routineId))
  if (!w) return null
  const navigate = useApp.getState().navigate
  return (
    <WidgetCard title={w.title} className="board-card">
      <Body id={w.id} body={w.body} />
      <div className="board-foot">
        {routine && (
          <span className="board-refresh">
            <RefreshCw size={12} />
            {t('定时任务 · {0}', describeSchedule(routine.schedule))}
          </span>
        )}
        <span>{t('{0}更新', relTime(w.updatedAt))}</span>
        {source && (
          <button className="board-source" onClick={() => navigate(routeFor(source))}>
            {t('来自「{0}」', source.title)}
          </button>
        )}
      </div>
    </WidgetCard>
  )
}

/** What a card's menu adds to moving and removing it: going to where it came from, and deleting it for good. */
function actions(w: BoardWidget): MenuItem[] {
  const source = useApp.getState().conversations.find((c) => c.id === w.createdBy)
  return [
    ...(source ? [{ icon: <ExternalLink size={15} />, label: t('打开来源对话'), onClick: () => useApp.getState().navigate(routeFor(source)) }] : []),
    {
      icon: <Trash2 size={15} />,
      label: t('删除卡片'),
      danger: true,
      onClick: async () => {
        const ask = w.routineId ? t('删除卡片「{0}」和刷新它的定时任务？', w.title) : t('删除卡片「{0}」？', w.title)
        if (await confirmDialog(ask, { ok: t('删除') })) api().deleteBoardWidget(w.id).catch(toastError)
      }
    }
  ]
}

// Keep one registered widget per card, re-registered only when what the board lays out (its title or size) changes.
const registered = new Map<string, { title: string; size: string; off: () => void }>()
function sync(cards: BoardWidget[]) {
  for (const [id, r] of registered)
    if (!cards.some((w) => w.id === id)) {
      r.off()
      registered.delete(id)
    }
  cards.forEach((w, i) => {
    const r = registered.get(w.id)
    if (r && r.title === w.title && r.size === w.size) return
    r?.off()
    const off = registerWidget({
      id: boardWidgetKey(w.id),
      title: w.title,
      size: w.size,
      order: 100 + i,
      Component: () => <BoardCard id={w.id} />,
      actions: () => actions(useApp.getState().boardWidgets.find((x) => x.id === w.id) ?? w)
    })
    registered.set(w.id, { title: w.title, size: w.size, off })
  })
}
sync(useApp.getState().boardWidgets)
useApp.subscribe((s, prev) => {
  if (s.boardWidgets !== prev.boardWidgets) sync(s.boardWidgets)
})
