import { useMemo } from 'react'
import { formatTokens } from '@shared/usage'
import { t } from '../../i18n'
import type { Widget } from '../registry'
import { WidgetCard, WidgetStat as Stat } from '../WidgetCard'
import { dayKey, today as midnight, useUsageSummary } from '../usage'

const YEAR = 365

/** A few figures for the past year: tokens, today's tokens, days with usage, the longest run of them. */
function UsageStats() {
  const usage = useUsageSummary()
  const figures = useMemo(() => {
    const byDay = new Map((usage?.days ?? []).map((d) => [d.day, d]))
    const day = midnight()
    day.setDate(day.getDate() - YEAR + 1)
    let total = 0
    let active = 0
    let run = 0
    let streak = 0
    for (let i = 0; i < YEAR; i++, day.setDate(day.getDate() + 1)) {
      const use = byDay.get(dayKey(day))
      total += use?.tokens ?? 0
      if (use) active++
      run = use ? run + 1 : 0
      streak = Math.max(streak, run)
    }
    return { total, active, streak, today: byDay.get(dayKey(midnight()))?.tokens ?? 0 }
  }, [usage])

  if (!usage?.days.length) return null
  return (
    <WidgetCard title={t('过去一年')} className="usage-stats">
      <Stat value={formatTokens(figures.total)} label={t('tokens')} />
      <Stat value={formatTokens(figures.today)} label={t('今天的 tokens')} />
      <Stat value={String(figures.active)} label={t('有用量的天数')} />
      <Stat value={t('{0} 天', figures.streak)} label={t('最长连续')} />
    </WidgetCard>
  )
}

export default { id: 'usage-stats', title: t('用量概览'), size: 'half', order: 20, Component: UsageStats } satisfies Widget
