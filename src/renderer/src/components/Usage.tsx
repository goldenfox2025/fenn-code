import { Gauge } from 'lucide-react'
import type { Message } from '@shared/model'
import { formatCost, formatTokens, type MessageUsage, type UsageTotals } from '@shared/usage'
import { useMenu, type MenuItem } from './Menu'
import { t } from '../i18n'

/** "1,234 tokens · $0.003" for one reply. */
export function usageLine(u: MessageUsage): string {
  const parts: string[] = []
  const total = u.total ?? (u.input ?? 0) + (u.output ?? 0)
  if (u.input !== undefined || u.output !== undefined || u.total !== undefined) parts.push(t('{0} tokens', formatTokens(total)))
  if (u.cost) parts.push(formatCost(u.cost))
  return parts.join(' · ')
}

function detailLines(u: MessageUsage | UsageTotals): string[] {
  const out: string[] = []
  if (u.input !== undefined) out.push(t('输入 {0}', formatTokens(u.input)))
  if (u.output !== undefined) out.push(t('输出 {0}', formatTokens(u.output)))
  if (u.thought) out.push(t('思考 {0}', formatTokens(u.thought)))
  if (u.cachedRead) out.push(t('缓存读取 {0}', formatTokens(u.cachedRead)))
  if (u.cachedWrite) out.push(t('缓存写入 {0}', formatTokens(u.cachedWrite)))
  return out
}

/** A reply's usage, quiet in the hover row next to its actions. */
export function MessageUsageLabel({ m }: { m: Message }) {
  if (!m.usage) return null
  const line = usageLine(m.usage)
  if (!line) return null
  return (
    <span className="msg-usage" title={[...detailLines(m.usage), m.usage.cost ? t('费用 {0}', formatCost(m.usage.cost)) : ''].filter(Boolean).join('\n')}>
      {line}
    </span>
  )
}

/** The items of a usage popover: totals, breakdown, cost and context, or 「后端未提供」. */
export function usageMenu(u: UsageTotals | undefined, scope: string): MenuItem[] {
  const items: MenuItem[] = [{ heading: scope }]
  if (!u || u.turns === 0) {
    items.push({ label: t('后端未提供'), sub: t('这个 agent 没有报告用量，所以这里不显示数字。'), info: true })
    return items
  }
  items.push({ label: t('{0} tokens', formatTokens(u.total)), sub: detailLines(u).join(' · '), info: true })
  items.push({
    label: u.cost ? t('费用 {0}', formatCost(u.cost)) : t('费用：后端未提供'),
    sub: u.costSkipped ? t('另有 {0} 轮的费用用的是别的币种，没有计入', u.costSkipped) : undefined,
    info: true
  })
  if (u.contextSize) {
    const used = u.contextUsed ?? 0
    items.push({ label: t('上下文 {0} / {1}（{2}%）', formatTokens(used), formatTokens(u.contextSize), Math.round((used / u.contextSize) * 100)), info: true })
  }
  items.push({
    label: t('共 {0} 轮', u.turns + u.unreported),
    sub: u.unreported ? t('其中 {0} 轮后端未提供用量，未计入', u.unreported) : undefined,
    info: true
  })
  return items
}

/** A small header button with the running total; click for the breakdown. */
export function UsageButton({ usage, scope, className = 'usage-btn' }: { usage: UsageTotals | undefined; scope: string; className?: string }) {
  const [menu, openMenu] = useMenu({ align: 'right' })
  if (!usage || usage.turns + usage.unreported === 0) return null
  const label = usage.turns ? usageLine({ total: usage.total, cost: usage.cost }) : t('用量：后端未提供')
  return (
    <>
      <button className={className} title={t('用量')} onClick={(e) => openMenu(e.currentTarget, usageMenu(usage, scope))}>
        <Gauge size={14} />
        <span>{label}</span>
      </button>
      {menu}
    </>
  )
}
