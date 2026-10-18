import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Gauge, Minimize2 } from 'lucide-react'
import type { CreditQuota } from '@shared/contract'
import type { Message } from '@shared/model'
import { formatCost, formatTokens, headline, MIN_STREAM_MS, type GenerationTiming, type MessageUsage, type UsageTotals } from '@shared/usage'
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

const NO_SPEED: Record<NonNullable<GenerationTiming['noSpeed']>, string> = {
  output: tk('没有速度：agent 没报告这条回复的输出 token 数'),
  short: tk('没有速度：回复不到 1 秒就到齐了'),
  waited: tk('没有速度：回复中途等过确认或重试'),
  stopped: tk('没有速度：回复没有正常结束')
}

/** How fast a reply streamed, as the app saw it (not the provider's own timing), or why that isn't known. */
function timingLines(timing: GenerationTiming): string[] {
  const speed = tokensPerSecond(timing)
  return [
    t('首个回复 {0}', seconds(timing.firstResponseMs)),
    speed !== undefined ? t('输出速度 {0}，平均每个 token {1}', rate(speed), seconds(timing.tpotMs!)) : timing.noSpeed ? t(NO_SPEED[timing.noSpeed]) : ''
  ].filter(Boolean)
}

/** Accounts billed in credits (Qoder) report no per-reply tokens worth showing. */
const usesCredits = (backendId?: string) => (s: ReturnType<typeof useApp.getState>) => !!s.backends.find((b) => b.id === backendId)?.credits

/** A reply's usage, quiet in the hover row next to its actions. */
export function MessageUsageLabel({ m }: { m: Message }) {
  const backendId = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.backendId)
  const credits = useApp(usesCredits(backendId))
  if (credits || !m.usage) return null
  const speed = tokensPerSecond(m.timing)
  const line = [usageLine(m.usage), speed !== undefined ? rate(speed) : ''].filter(Boolean).join(' · ')
  if (!line) return null
  const title = [...detailLines(m.usage), m.usage.cost && m.usage.cost.amount > 0 ? t('费用 {0}', formatCost(m.usage.cost)) : '', ...(m.timing ? timingLines(m.timing) : [])]
  return (
    <span className="msg-usage" data-tip={title.filter(Boolean).join('\n')}>
      {line}
    </span>
  )
}

/** How full a share is, as a tone: the bar and the ring turn amber, then red, as the context fills. */
const tone = (share: number) => (share >= 0.9 ? 'full' : share >= 0.75 ? 'high' : '')

/** A thin bar for a share of something (context window, plan credits); it grows into place and follows live figures. */
function Meter({ label, used, total, colored }: { label: string; used: number; total: number; colored?: boolean }) {
  const share = Math.max(0, Math.min(1, used / total))
  return (
    <span
      className={'menu-meter' + (colored ? ' colored ' + tone(share) : '')}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={Math.min(used, total)}
    >
      <span style={{ width: `${share * 100}%` }} />
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

/** "58 tok/s": whole numbers from 100 up. */
const rate = (speed: number) => t('{0} tok/s', speed >= 100 ? Math.round(speed) : speed.toFixed(1))

/** Output tokens per second over the last uninterrupted stream, when the agent reported its output. */
export function tokensPerSecond(timing?: GenerationTiming): number | undefined {
  if (!timing?.streamMs || timing.streamMs < MIN_STREAM_MS || !timing.outputTokens) return undefined
  return timing.outputTokens / (timing.streamMs / 1000)
}

/** One line of the panel: a label and its figure on the right. */
function Row({ label, value, note, tip }: { label: ReactNode; value?: ReactNode; note?: ReactNode; tip?: string }) {
  return (
    <div className="usage-row">
      <span className="usage-label">
        {label}
        {note && <span className="usage-note">{note}</span>}
      </span>
      {value !== undefined && <span className="usage-value" data-tip={tip}>{value}</span>}
    </div>
  )
}

/**
 * A conversation's usage, laid out as Claude's usage popover: how full the
 * context is, then cost and the speed of the latest reply. Only reported figures.
 */
function UsagePanel({ u, scope, timing }: { u?: UsageTotals; scope: string; timing?: GenerationTiming }) {
  const hasCtx = u?.contextUsed !== undefined
  const cost = u?.cost && u.cost.amount > 0 ? u.cost : undefined
  if (!u || (!hasCtx && !cost && !timing))
    return (
      <div className="usage-panel">
        <div className="usage-head">{scope}</div>
        <div className="usage-empty">{t('第一条回复完成后，这里会显示 agent 报告的用量。')}</div>
      </div>
    )
  const from = [u.contextSource && t(SOURCE[u.contextSource]), u.contextSizeSource === 'table' && t(SOURCE.table)].filter(Boolean).join(' · ')
  const speed = tokensPerSecond(timing)
  return (
    <div className="usage-panel">
      <div className="usage-head">{scope}</div>
      {hasCtx && (
        <div className="usage-section">
          <Row
            label={t('上下文')}
            value={u.contextSize ? `${formatTokens(u.contextUsed!)} / ${formatTokens(u.contextSize)} · ${percent(u.contextUsed!, u.contextSize)}` : t('已用 {0}', formatTokens(u.contextUsed!))}
            tip={from || undefined}
          />
          {u.contextSize ? <Meter label={t('上下文')} used={u.contextUsed!} total={u.contextSize} colored /> : <div className="usage-foot">{t('不知道窗口大小，所以不显示百分比')}</div>}
        </div>
      )}
      {cost && (
        <div className="usage-section">
          <Row label={t('费用')} note={t('按标价估算')} value={formatCost(cost)} tip={t('订阅账号不实际扣费')} />
          {(u.unreported > 0 && u.turns > 0) || u.costSkipped ? (
            <div className="usage-foot">
              {[
                u.unreported > 0 && u.turns > 0 ? t('其中 {0} 轮后端未提供用量，未计入', u.unreported) : '',
                u.costSkipped ? t('另有 {0} 轮的费用用的是别的币种，没有计入', u.costSkipped) : ''
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          ) : null}
        </div>
      )}
      {timing && (
        <div className="usage-section">
          <div className="usage-head">{t('最近一次回复')}</div>
          <Row label={t('首个回复')} value={seconds(timing.firstResponseMs)} />
          {speed !== undefined && <Row label={t('输出速度')} value={rate(speed)} tip={t('按 Fenn Code 看到的输出时间计算，不含工具运行的时间')} />}
          {speed !== undefined && <Row label={t('每个 token')} value={seconds(timing.tpotMs!)} tip={t('输出时平均每个 token 的间隔（TPOT）')} />}
          {speed === undefined && timing.noSpeed && <div className="usage-foot">{t(NO_SPEED[timing.noSpeed])}</div>}
        </div>
      )}
    </div>
  )
}

/** The usage popover's items: the panel, laid out on its own (nothing in it is a choice). */
export function usageMenu(u: UsageTotals | undefined, scope: string, timing?: GenerationTiming): MenuItem[] {
  return [{ panel: <UsagePanel u={u} scope={scope} timing={timing} /> }]
}

const credits = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
const BUCKET: Record<string, string> = { Plan: tk('套餐'), 'Add-on': tk('加购额度'), Organization: tk('组织额度') }

/** The account's credit buckets, as the backend reported them a moment ago. */
export function creditsMenu(quota: CreditQuota | undefined, name: string, loading: boolean): MenuItem[] {
  const items: MenuItem[] = [{ heading: t('{0} 账户额度', name) }]
  if (!quota) {
    items.push({ label: loading ? t('正在查询额度…') : t('后端未提供'), info: true, busy: loading })
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
  // An arc around the ring, as far as the context is full; it turns amber, then red, and moves as the figure changes.
  const r = 6.4
  const length = 2 * Math.PI * r
  return (
    <>
      <button
        className={'context-ring ' + tone(share) + (used === undefined ? ' none' : '')}
        data-tip={title}
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation()
          // The agent's own compact command, when it has one, as Claude Code's /compact.
          // Nothing to compact before the first turn.
          const something = !!used || (usage?.turns ?? 0) + (usage?.unreported ?? 0) > 0
          openMenu(e.currentTarget, [
            ...usageMenu(usage, scope, timing),
            ...(onCompact && something ? [{ separator: true }, { label: t('压缩上下文'), icon: <Minimize2 size={15} />, onClick: onCompact }] : [])
          ])
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} className="ring-track" />
          {share > 0 && <circle cx="9" cy="9" r={r} className="ring-arc" strokeDasharray={length} strokeDashoffset={length * (1 - share)} transform="rotate(-90 9 9)" />}
        </svg>
      </button>
      {menu}
    </>
  )
}

