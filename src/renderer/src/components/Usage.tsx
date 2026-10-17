import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Gauge } from 'lucide-react'
import type { CreditQuota } from '@shared/contract'
import type { Message } from '@shared/model'
import { formatCost, formatTokens, headline, type GenerationTiming, type MessageUsage, type UsageTotals } from '@shared/usage'
import { useMenu, type MenuItem } from './Menu'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { tk } from '@shared/i18n'

/** "1,234 tokens · $0.003" for one reply. */
export function usageLine(u: MessageUsage): string {
  const parts: string[] = []
  const total = headline(u)
  if (total > 0) parts.push(t('{0} tokens', formatTokens(total)))
  // ACP reports a running cost; a reply that added nothing shows none rather than $0.0000.
  if (u.cost && u.cost.amount > 0) parts.push(formatCost(u.cost))
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

const seconds = (ms: number) => (ms < 1000 ? t('{0} 毫秒', Math.round(ms)) : t('{0} 秒', (ms / 1000).toFixed(1)))

/** How fast the last reply streamed, as the app saw it (not the provider's own timing). */
function timingLine(timing: GenerationTiming): string {
  const parts = [t('首个回复 {0}', seconds(timing.firstResponseMs))]
  if (timing.tpotMs !== undefined && Math.round(timing.tpotMs) > 0) parts.push(t('平均每个 token {0}', seconds(timing.tpotMs)))
  return parts.join(' · ')
}

/** Accounts billed in credits (Qoder) report no per-reply tokens worth showing. */
const usesCredits = (backendId?: string) => (s: ReturnType<typeof useApp.getState>) => !!s.backends.find((b) => b.id === backendId)?.credits

/** A reply's usage, quiet in the hover row next to its actions. */
export function MessageUsageLabel({ m }: { m: Message }) {
  const backendId = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.backendId)
  const credits = useApp(usesCredits(backendId))
  if (credits || !m.usage) return null
  const line = usageLine(m.usage)
  if (!line) return null
  const title = [...detailLines(m.usage), m.usage.cost && m.usage.cost.amount > 0 ? t('费用 {0}', formatCost(m.usage.cost)) : '', m.timing ? timingLine(m.timing) : '']
  return (
    <span className="msg-usage" data-tip={title.filter(Boolean).join('\n')}>
      {line}
    </span>
  )
}

/** A thin bar for a share of something (context window, plan credits). */
function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = Math.max(0, Math.min(100, (used / total) * 100))
  return (
    <span className="menu-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(used, total)}>
      <span style={{ width: `${pct}%` }} />
    </span>
  )
}

const percent = (used: number, total: number) => {
  const p = (used / total) * 100
  if (p >= 100) return t('已满')
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

const SOURCE: Record<string, string> = {
  agent: tk('agent 报告'),
  log: tk('读取自 agent 的会话日志'),
  table: tk('窗口大小来自模型上限表')
}

/** The context row: N / M (P%) with a bar, or 已用 N when the window size is unknown. */
function contextItem(u: UsageTotals): MenuItem | undefined {
  if (u.contextUsed === undefined) return undefined
  const used = u.contextUsed
  const from = [u.contextSource && t(SOURCE[u.contextSource]), u.contextSizeSource === 'table' && t(SOURCE.table)].filter(Boolean).join(' · ')
  if (!u.contextSize)
    return { label: t('上下文 已用 {0}', formatTokens(used)), sub: [from, t('不知道窗口大小，所以不显示百分比')].filter(Boolean).join(' · '), info: true }
  return {
    label: t('上下文 {0} / {1}（{2}）', formatTokens(used), formatTokens(u.contextSize), percent(used, u.contextSize)),
    sub: (
      <span className="menu-meter-sub">
        <Meter label={t('上下文')} used={used} total={u.contextSize} />
        {from && <span>{from}</span>}
      </span>
    ),
    info: true
  }
}

/**
 * The items of a usage popover: context, then this conversation's new input,
 * output and cache figures on separate rows, and cost only when the agent
 * reported one. Nothing is estimated.
 */
export function usageMenu(u: UsageTotals | undefined, scope: string, timing?: GenerationTiming): MenuItem[] {
  const items: MenuItem[] = [{ heading: scope }]
  const ctx = u && contextItem(u)
  if (!u || (u.turns + u.unreported === 0 && !ctx)) {
    items.push({ label: t('还没有用量'), sub: t('第一条回复完成后，这里会显示 agent 报告的用量。'), info: true })
    return items
  }
  if (ctx) items.push(ctx)
  // [label, value, shown even when zero]
  const rows: [string, number | undefined, boolean][] = [
    [tk('新输入'), u.input, true],
    [tk('输出'), u.output, true],
    [tk('思考'), u.thought || undefined, false],
    [tk('缓存读取'), u.cachedRead, false],
    [tk('缓存写入'), u.cachedWrite, false]
  ]
  // Only real per-turn figures: an agent that reports just the context leaves these at zero.
  if (u.turns > 0 && rows.some(([, v]) => !!v)) {
    // Cache rows only when there was any; new input and output always.
    for (const [label, v, always] of rows) if (v !== undefined && (v > 0 || always)) items.push({ label: t(label), hint: formatTokens(v), info: true })
  } else if (!ctx) {
    items.push({ label: t('这个 agent 不提供用量'), sub: t('它没有报告 token 数，所以这里不显示数字。'), info: true })
  }
  if (u.cost && u.cost.amount > 0)
    items.push({
      label: t('费用'),
      hint: formatCost(u.cost),
      sub: [t('按标价估算，订阅账号不实际扣费'), u.costSkipped ? t('另有 {0} 轮的费用用的是别的币种，没有计入', u.costSkipped) : ''].filter(Boolean).join(' · '),
      info: true
    })
  if (timing) items.push({ label: t('最近一次回复'), sub: timingLine(timing), info: true })
  items.push({
    label: t('共 {0} 轮', u.turns + u.unreported),
    sub: u.unreported && u.turns ? t('其中 {0} 轮后端未提供用量，未计入', u.unreported) : undefined,
    info: true
  })
  return items
}

const credits = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const BUCKET: Record<string, string> = { Plan: tk('套餐'), 'Add-on': tk('加购额度'), Organization: tk('组织额度') }

/** The account's credit buckets, as the backend reported them a moment ago. */
export function creditsMenu(quota: CreditQuota | undefined, name: string, loading: boolean): MenuItem[] {
  const items: MenuItem[] = [{ heading: t('{0} 账户额度', name) }]
  if (!quota) {
    items.push({ label: loading ? t('正在查询额度…') : t('后端未提供'), info: true })
    return items
  }
  for (const b of quota.buckets) {
    const label = t(BUCKET[b.name] ?? b.name)
    const sub: ReactNode[] = []
    if (b.used !== undefined && b.total) sub.push(<Meter key="m" label={label} used={b.used} total={b.total} />)
    if (b.remaining !== undefined) sub.push(<span key="r">{t('剩余 {0}', credits(b.remaining))}</span>)
    items.push({
      label:
        b.used !== undefined && b.total
          ? t('{0} · {1} / {2} credits（{3}）', label, credits(b.used), credits(b.total), percent(b.used, b.total))
          : t('{0} · {1} credits', label, credits(b.used ?? b.total ?? b.remaining ?? 0)),
      sub: sub.length ? <span className="menu-meter-sub">{sub}</span> : undefined,
      info: true
    })
  }
  items.push({ label: t('包括其他会话的消耗'), sub: t('更新于 {0}', new Date(quota.at).toLocaleTimeString()), info: true })
  return items
}

/** A small header button with the running total; click for the breakdown. */
export function UsageButton({
  usage,
  scope,
  backendId,
  timing,
  className = 'usage-btn',
  align = 'right',
  children,
  creditsOnly
}: {
  usage: UsageTotals | undefined
  scope: string
  backendId?: string
  timing?: GenerationTiming
  className?: string
  align?: 'left' | 'right'
  children?: ReactNode
  /** In a conversation header: token usage lives in the composer's ring, so only account credits show here. */
  creditsOnly?: boolean
}) {
  const credits = useApp(usesCredits(backendId))
  if (credits && backendId) return <CreditsButton backendId={backendId} className={className} activity={(usage?.turns ?? 0) + (usage?.unreported ?? 0)} />
  if (creditsOnly) return null
  return <TokensButton usage={usage} scope={scope} timing={timing} className={className} align={align}>{children}</TokensButton>
}

function TokensButton({ usage, scope, timing, className, align, children }: {
  usage?: UsageTotals
  scope: string
  timing?: GenerationTiming
  className: string
  align: 'left' | 'right'
  children?: ReactNode
}) {
  const [menu, openMenu] = useMenu({ align, compact: true })
  if (!usage || usage.turns + usage.unreported === 0) return null
  const label = usage.turns ? usageLine({ total: usage.total, cost: usage.cost }) : t('用量：agent 不提供')
  return (
    <>
      <button className={className} data-tip={t('用量')} onClick={(e) => openMenu(e.currentTarget, usageMenu(usage, scope, timing))}>
        {children ?? (
          <>
            <Gauge size={14} />
            <span>{label}</span>
          </>
        )}
      </button>
      {menu}
    </>
  )
}

/** Credits are an account balance: read when shown, after each reply, and once a minute. */
function CreditsButton({ backendId, className, activity }: { backendId: string; className: string; activity: number }) {
  const name = useApp((s) => s.backends.find((b) => b.id === backendId)?.name ?? backendId)
  const [quota, setQuota] = useState<CreditQuota | undefined>()
  const [loading, setLoading] = useState(false)
  const [menu, openMenu, updateMenu] = useMenu({ align: 'right', compact: true })
  const seen = useRef({ backendId, activity })
  useEffect(() => {
    let live = true
    const afterReply = seen.current.backendId === backendId && seen.current.activity !== activity
    if (seen.current.backendId !== backendId) setQuota(undefined)
    seen.current = { backendId, activity }
    const read = (fresh = false) => {
      setLoading(true)
      api()
        .backendCredits(backendId, fresh)
        .then((q) => live && setQuota(q), () => live && setQuota(undefined))
        .finally(() => live && setLoading(false))
    }
    read(afterReply)
    const timer = setInterval(read, 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [backendId, activity])
  // An open menu shows the latest numbers when they arrive.
  useEffect(() => updateMenu(creditsMenu(quota, name, loading)), [quota, loading])
  const first = quota?.buckets[0]
  const label = first?.used !== undefined && first.total ? t('{0} / {1} credits', credits(first.used), credits(first.total)) : 'Credits'
  return (
    <>
      <button
        className={className}
        data-tip={t('{0} 账户额度', name)}
        onClick={(e) => openMenu(e.currentTarget, creditsMenu(quota, name, loading))}
      >
        <Gauge size={14} />
        <span>{label}</span>
      </button>
      {menu}
    </>
  )
}

/**
 * How full the context window is, as a small ring beside the model name (like
 * Claude's): the last model call against the window. Only figures the agent
 * reported (over ACP or in its own log); otherwise a plain grey ring. Click for
 * the usage details.
 */
export function ContextRing({ usage, scope, timing, onCompact }: { usage?: UsageTotals; scope: string; timing?: GenerationTiming; onCompact?: () => void }) {
  const [menu, openMenu] = useMenu({ align: 'right', placement: 'auto', compact: true })
  const size = usage?.contextSize
  const used = usage?.contextUsed
  const share = size && used !== undefined ? Math.max(0, Math.min(1, used / size)) : 0
  const title =
    used === undefined
      ? !usage || usage.turns + usage.unreported === 0
        ? t('还没有用量')
        : usage.turns > 0 && (usage.input || usage.output)
          ? t('这个 agent 不报告上下文用量')
          : t('这个 agent 不提供用量')
      : size
        ? t('上下文 {0} / {1}（{2}）', formatTokens(used), formatTokens(size), percent(used, size))
        : t('上下文 已用 {0}', formatTokens(used))
  // A small static pie, like Claude's: an outline, filled as far as the context is.
  const a = share * 2 * Math.PI
  const r = 4.6
  const end = [9 + r * Math.sin(a), 9 - r * Math.cos(a)]
  const pie = share >= 0.999 ? <circle cx="9" cy="9" r={r} className="ring-fill" /> : share > 0 ? (
    <path className="ring-fill" d={`M9 9 L9 ${9 - r} A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${end[0].toFixed(2)} ${end[1].toFixed(2)} Z`} />
  ) : null
  return (
    <>
      <button
        className={'context-ring' + (share >= 0.9 ? ' full' : share >= 0.75 ? ' high' : '') + (used === undefined ? ' none' : '')}
        data-tip={title}
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation()
          // The agent's own compact command, when it has one, as Claude Code's /compact.
          openMenu(e.currentTarget, [...usageMenu(usage, scope, timing), ...(onCompact ? [{ separator: true }, { label: t('压缩上下文'), onClick: onCompact }] : [])])
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="6.6" className="ring-track" />
          {pie}
        </svg>
      </button>
      {menu}
    </>
  )
}
