/**
 * Context-window sizes from a bundled snapshot of LiteLLM's model table
 * (scripts/model-limits.mjs refreshes it). Used only when the agent itself
 * doesn't say how big the window is; an unknown model has no size.
 */
import table from './modelLimits.json'

const limits = table.limits as Record<string, number>

export function contextLimit(modelId?: string): number | undefined {
  if (!modelId) return undefined
  let id = modelId.trim().toLowerCase()
  // "sonnet[1m]"-style ids name the window outright.
  if (/\[1m\]$/.test(id)) return 1_000_000
  // "openai/gpt-5.5", "gpt-5.5/high", "gpt-5.5 (high)": the model is the provider-less part before any effort suffix.
  id = id.replace(/\s*\(.*\)$/, '')
  const parts = id.split('/')
  for (const candidate of [id, parts[parts.length - 1], parts[0], parts.length > 1 ? parts[1] : '']) {
    if (candidate && limits[candidate]) return limits[candidate]
  }
  // A build or variant of a known model ("grok-4.7-build"): the longest known name it starts with.
  const base = parts[parts.length - 1]
  let best = ''
  for (const k of Object.keys(limits)) if (k.length > best.length && base.startsWith(k + '-')) best = k
  return best ? limits[best] : undefined
}
