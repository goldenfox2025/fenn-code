import type { CreditQuota } from '../../shared/contract'

/** Account-wide limits; no context-window numbers and no estimated ceiling. */
export function codexQuota(value: unknown, at = Date.now()): CreditQuota | undefined {
  const response = value as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> } | undefined
  const limits = response?.rateLimitsByLimitId ? Object.values(response.rateLimitsByLimitId) : response?.rateLimits ? [response.rateLimits] : []
  const buckets: CreditQuota['buckets'] = []
  const seen = new Set<string>()
  for (const item of limits) {
    const limit = item as { limitId?: string; limitName?: string; primary?: { usedPercent?: number; windowDurationMins?: number }; secondary?: { usedPercent?: number; windowDurationMins?: number } }
    for (const window of [limit.primary, limit.secondary]) {
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue
      const duration = window.windowDurationMins
      const name = `${limit.limitName || limit.limitId || 'Codex'}${duration ? ` · ${duration >= 1440 ? `${duration / 1440} 天` : duration >= 60 ? `${duration / 60} 小时` : `${duration} 分钟`}` : ''}`
      const key = `${name}:${duration}`
      if (seen.has(key)) continue
      seen.add(key); const used = Math.max(0, Math.min(100, window.usedPercent))
      buckets.push({ name, used, remaining: 100 - used, total: 100, unit: '%' })
    }
  }
  return buckets.length ? { buckets, at } : undefined
}
