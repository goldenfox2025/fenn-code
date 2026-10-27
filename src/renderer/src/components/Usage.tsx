import { useEffect, useState, type ReactNode } from 'react'
import { Minimize2 } from 'lucide-react'
import type { CreditQuota } from '@shared/contract'
import type { Message } from '@shared/model'
import { formatCost, formatTokens, headline, inputRead, MIN_STREAM_MS, type GenerationTiming, type MessageUsage, type UsageTotals } from '@shared/usage'
import { useMenu, type MenuItem } from './Menu'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { tk } from '@shared/i18n'

/**
 * "输入 13.7k · 输出 8 · $0.003" (or "输入 773k（缓存 773k）· …") for one reply: input and output apart, so the context the reply
 * read isn't taken for the size of the reply; a bare total only when the agent gave nothing finer.
 */
export function usageLine(u: MessageUsage): string {
  const parts: string[] = []
  const total = headline(u)
  const input = inputRead(u)
  if (input !== undefined && u.output !== undefined)
    parts.push(
      input.cached ? t('输入 {0}（缓存 {1}）', formatTokens(input.total), formatTokens(input.cached)) : t('输入 {0}', formatTokens(input.total)),
      t('输出 {0}', formatTokens(u.output))
    )
  else if (u.output !== undefined && u.output > 0) parts.push(t('输出 {0}', formatTokens(u.output)))
  else if (total > 0) parts.push(t('{0} tokens', formatTokens(total)))
  // ACP reports a running cost; a reply that added nothing shows none rather than $0.0000.
  if (u.cost && u.cost.amount > 0) parts.push(formatCost(u.cost))
  return parts.join(' · ')
}

const seconds = (ms: number) => (ms < 1000 ? t('{0} 毫秒', Math.round(ms)) : t('{0} 秒', (ms / 1000).toFixed(1)))

/** Accounts billed in credits (Qoder) report no per-reply tokens worth showing. */
const usesCredits = (backendId?: string) => (s: ReturnType<typeof useApp.getState>) => backendId === 'qoder' && !!s.backends.find((b) => b.id === backendId)?.credits

/** Quiet metadata for substantial completed work; no accounting submenu. */
export function MessageUsageLabel({ m }: { m: Message }) {
  const backendId = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.backendId)
  const credits = useApp(usesCredits(backendId))
  const speed = tokensPerSecond(m.timing), chars = charsPerSecond(m.timing)
  const substantial = (m.usage?.output ?? 0) >= 512 || (m.timing?.streamMs ?? 0) >= 5000 || m.blocks.some(b => b.type === 'tool' || b.type === 'artifact') || m.blocks.some(b => b.type === 'text' && b.text.length >= 400)
  if (credits || !substantial) return null
  const parts = [m.usage ? usageLine(m.usage) : '', speed !== undefined ? rate(speed) : chars !== undefined ? charRate(chars) : '', speed !== undefined && m.timing?.tpotMs !== undefined ? `TPOT ${seconds(m.timing.tpotMs)}` : ''].filter(Boolean)
  return parts.length ? <span className="reply-metrics" aria-label={t('本条回复用量')}>{parts.join(' · ')}</span> : null
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

/** "42 字/秒": characters of text per second, for an agent that reports no token counts. */
const charRate = (speed: number) => t('{0} 字/秒', speed >= 100 ? Math.round(speed) : speed.toFixed(1))

/** Characters per second over an uninterrupted stream, when the agent reported no output tokens. */
export function charsPerSecond(timing?: GenerationTiming): number | undefined {
  if (!timing?.streamMs || timing.streamMs < MIN_STREAM_MS || !timing.outputChars || timing.outputTokens) return undefined
  return timing.outputChars / (timing.streamMs / 1000)
}

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
  const onlyShare = !hasCtx && u?.contextShare !== undefined
  const cost = u?.cost && u.cost.amount > 0 ? u.cost : undefined
  if (!u || (!hasCtx && !onlyShare && !cost && !timing))
    return (
      <div className="usage-panel">
        <div className="usage-head">{scope}</div>
        <div className="usage-empty">{t('第一条回复完成后，这里会显示 agent 报告的用量。')}</div>
      </div>
    )
  const from = [u.contextSource && t(SOURCE[u.contextSource]), u.contextSizeSource === 'table' && t(SOURCE.table)].filter(Boolean).join(' · ')
  const speed = tokensPerSecond(timing)
  const chars = charsPerSecond(timing)
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
      {onlyShare && (
        <div className="usage-section">
          <Row label={t('上下文')} value={t('已用 {0}', percent(u.contextShare!, 1))} tip={from || undefined} />
          <Meter label={t('上下文')} used={u.contextShare!} total={1} colored />
          <div className="usage-foot">{t('agent 只报告了占用比例，没有报告 token 数')}</div>
        </div>
      )}
      {cost && (
        <div className="usage-section">
          <Row label={t('费用')} note={t('后端报告')} value={formatCost(cost)} />
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
      {(speed !== undefined || chars !== undefined) && timing && (
        <div className="usage-section">
          <div className="usage-head">{t('最近一次回复')}</div>
          <div className="usage-performance" data-tip={t('按 Fenn Code 看到的输出时间计算，不含工具运行的时间')}><span>{speed !== undefined ? rate(speed) : chars !== undefined ? charRate(chars) : ''}</span>{speed !== undefined && timing.tpotMs !== undefined && <><span className="usage-performance-separator">·</span><span>{seconds(timing.tpotMs)} / token</span></>}</div>
          {speed === undefined && chars === undefined && timing.outputTokens !== undefined && (
            <Row label={t('输出')} value={t('{0} token', formatTokens(timing.outputTokens))} tip={t('agent 报告的这条回复的输出 token 数')} />
          )}
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
    if (b.remaining !== undefined) sub.push(<span key="r">{t('剩余 {0}', credits(b.remaining))}{b.unit === '%' ? '%' : ''}</span>)
    items.push({
      label:
        b.unit === '%' && b.used !== undefined ? `${label} · ${t('已用 {0}', percent(b.used, 100))}` : b.used !== undefined && b.total
          ? t('{0} · {1} / {2} credits（{3}）', label, credits(b.used), credits(b.total), percent(b.used, b.total))
          : t('{0} · {1} credits', label, credits(b.used ?? b.total ?? b.remaining ?? 0)),
      sub: sub.length ? <span className="menu-meter-sub">{sub}</span> : undefined,
      info: true
    })
  }
  items.push({ label: t('包括其他会话的消耗'), sub: t('更新于 {0}', new Date(quota.at).toLocaleTimeString()), info: true })
  return items
}

/** Account-wide quota occupies the same quiet footer slot for supported providers. */
function AccountQuotaRing({ backendId, activity, onCompact }: { backendId: string; activity: number; onCompact?: () => void }) {
  const name = useApp(s => s.backends.find(backend => backend.id === backendId)?.name || backendId)
  const [quota, setQuota] = useState<CreditQuota>(), [loading, setLoading] = useState(true)
  const [menu, openMenu, update] = useMenu({ align: 'right', placement: 'auto', compact: true })
  useEffect(() => {
    let live = true
    const read = () => { setLoading(true); void api().backendCredits(backendId).then(value => { if (live) setQuota(value) }, () => { if (live) setQuota(undefined) }).finally(() => { if (live) setLoading(false) }) }
    setQuota(undefined); read(); const timer = setInterval(read, 60000)
    return () => { live = false; clearInterval(timer) }
  }, [backendId, activity])
  const items = () => [...creditsMenu(quota, name, loading), ...(onCompact ? [{ separator: true }, { label: t('压缩上下文'), icon: <Minimize2 size={15} />, onClick: onCompact }] : [])]
  useEffect(() => update(items()), [quota, loading, name])
  const first = quota?.buckets.find(bucket => bucket.used !== undefined && !!bucket.total)
  const share = first ? Math.max(0, Math.min(1, first.used! / first.total!)) : 0, radius = 6.4, length = 2 * Math.PI * radius
  if (!quota?.buckets.length) return null
  return <><button className={`context-ring account-quota-ring ${tone(share)}`} aria-label={t('{0} 账户额度', name)} data-tip={first ? `${name} · ${percent(first.used!, first.total!)}` : t('{0} 账户额度', name)} onClick={event => { event.stopPropagation(); openMenu(event.currentTarget, items()) }}><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r={radius} className="ring-track" />{first && <circle cx="9" cy="9" r={radius} className="ring-arc" strokeDasharray={length} strokeDashoffset={length * (1 - share)} transform="rotate(-90 9 9)" />}</svg></button>{menu}</>
}

/**
 * How full the context window is, as a small ring beside the model name (like
 * Claude's): the last model call against the window. Only figures the agent
 * reported (over ACP or in its own log); otherwise a plain grey ring. Click for
 * the usage details.
 */
export function ContextRing({ usage, scope, timing, onCompact, backendId }: { usage?: UsageTotals; scope: string; timing?: GenerationTiming; onCompact?: () => void; backendId?: string }) {
  const [menu, openMenu] = useMenu({ align: 'right', placement: 'auto', compact: true })
  const accountQuota = useApp(s => !!s.backends.find(backend => backend.id === backendId)?.credits)
  if (accountQuota && backendId) return <AccountQuotaRing backendId={backendId} activity={(usage?.turns || 0) + (usage?.unreported || 0)} onCompact={onCompact} />
  const size = usage?.contextSize
  const used = usage?.contextUsed
  if (used === undefined && usage?.contextShare === undefined && !usage?.cost) return null
  // Tokens against the window, or the share an agent reports alone (Qoder).
  const reported = used !== undefined ? (size ? used / size : undefined) : usage?.contextShare
  const share = reported !== undefined ? Math.max(0, Math.min(1, reported)) : 0
  const title =
    used !== undefined
      ? size
        ? t('上下文 {0} / {1}（{2}）', formatTokens(used), formatTokens(size), percent(used, size))
        : t('上下文 已用 {0}', formatTokens(used))
      : usage?.contextShare !== undefined
        ? t('上下文 已用 {0}', percent(usage.contextShare, 1))
        : !usage || usage.turns + usage.unreported === 0
          ? t('还没有用量')
          : usage.turns > 0 && (usage.input || usage.output)
            ? t('这个 agent 不报告上下文用量')
            : t('这个 agent 不提供用量')
  // An arc around the ring, as far as the context is full; it turns amber, then red, and moves as the figure changes.
  const r = 6.4
  const length = 2 * Math.PI * r
  return (
    <>
      <button
        className={'context-ring ' + tone(share) + (used === undefined && usage?.contextShare === undefined ? ' none' : '')}
        data-tip={title}
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation()
          // The agent's own compact command, when it has one, as Claude Code's /compact.
          // Nothing to compact before the first turn.
          const something = !!used || !!usage?.contextShare || (usage?.turns ?? 0) + (usage?.unreported ?? 0) > 0
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

