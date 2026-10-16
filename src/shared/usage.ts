/**
 * Token and cost bookkeeping. Numbers a backend reported are used as they are.
 * When it reports nothing, the app counts the text it sent and received with a
 * rough tokenizer and marks those turns as estimated, so totals never pass off
 * a guess as the backend's figure.
 */
import type { Cost, TurnUsage } from './contract'

/** Monotonic timings observed at the client; never presented as server/GPU latency. */
export interface GenerationTiming {
  firstResponseMs: number
  /** Only for uninterrupted streams with reported output counts. */
  tpotMs?: number
  streamMs?: number
  outputTokens?: number
}

/** One reply's usage: the tokens the backend reported, and what the turn cost if it said. */
export interface MessageUsage extends TurnUsage {
  cost?: Cost
  /** Counted by the app from the text exchanged, because the backend reported no tokens. */
  estimated?: boolean
}

/** Totals for a conversation (or a project, summed over its conversations). */
export interface UsageTotals {
  input: number
  output: number
  total: number
  thought?: number
  cachedRead?: number
  cachedWrite?: number
  /** Turns with reported usage. */
  turns: number
  /** Finished turns the backend reported no usage for (and that had nothing to estimate from). */
  unreported: number
  /** Of `turns`, those whose tokens the app estimated. */
  estimated?: number
  cost?: Cost
  /** Turns whose cost was in a different currency than `cost`, so not added in. */
  costSkipped?: number
  /** The context window as last reported (conversations only). */
  contextUsed?: number
  contextSize?: number
  /** The app's own estimate of the current session's context, for when the backend reports none. */
  contextEstimate?: number
}

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, total: 0, turns: 0, unreported: 0 })

const add = (a: number | undefined, b: number | undefined): number | undefined => (b === undefined ? a : (a ?? 0) + b)

function addCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
  if (!b) return a
  if (!a) return { ...b }
  // Mixed currencies can't be summed; keep the first.
  return a.currency === b.currency ? { amount: a.amount + b.amount, currency: a.currency } : a
}

/** Adds one turn: its usage when reported, otherwise one more unreported turn. */
export function addTurn(t: UsageTotals | undefined, u: MessageUsage | undefined): UsageTotals {
  const x = { ...(t ?? emptyTotals()) }
  const tokens = u && (u.input !== undefined || u.output !== undefined || u.total !== undefined)
  if (!u || (!tokens && !u.cost)) {
    x.unreported++
    return x
  }
  x.input += u.input ?? 0
  x.output += u.output ?? 0
  x.total += u.total ?? (u.input ?? 0) + (u.output ?? 0)
  x.thought = add(x.thought, u.thought)
  x.cachedRead = add(x.cachedRead, u.cachedRead)
  x.cachedWrite = add(x.cachedWrite, u.cachedWrite)
  if (u.cost && x.cost && u.cost.currency !== x.cost.currency) x.costSkipped = (x.costSkipped ?? 0) + 1
  else x.cost = addCost(x.cost, u.cost)
  x.turns++
  if (u.estimated) x.estimated = (x.estimated ?? 0) + 1
  return x
}

/** Sums several conversations' totals (context figures are per conversation and are left out). */
export function sumTotals(list: (UsageTotals | undefined)[]): UsageTotals {
  const x = emptyTotals()
  for (const t of list) {
    if (!t) continue
    x.input += t.input
    x.output += t.output
    x.total += t.total
    x.thought = add(x.thought, t.thought)
    x.cachedRead = add(x.cachedRead, t.cachedRead)
    x.cachedWrite = add(x.cachedWrite, t.cachedWrite)
    x.turns += t.turns
    x.unreported += t.unreported
    x.estimated = add(x.estimated, t.estimated)
    x.costSkipped = add(x.costSkipped, t.costSkipped)
    if (t.cost && x.cost && t.cost.currency !== x.cost.currency) x.costSkipped = (x.costSkipped ?? 0) + t.turns
    else x.cost = addCost(x.cost, t.cost)
  }
  return x
}

/** 1234 → "1,234"; 12345 → "12.3k"; 1234567 → "1.23M". */
export function formatTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatCost(c: Cost): string {
  const sym: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥' }
  const digits = c.amount < 0.01 ? 4 : c.amount < 1 ? 3 : 2
  const v = c.amount.toFixed(digits)
  return sym[c.currency.toUpperCase()] ? `${sym[c.currency.toUpperCase()]}${v}` : `${v} ${c.currency}`
}

/**
 * A rough token count for text, for when the backend reports none. Common
 * tokenizers give about one token per CJK character and about four characters
 * per token for English and code; this follows that and stays within roughly
 * 20% of real counts for ordinary chat text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let wide = 0
  for (const ch of text) if (/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/.test(ch)) wide++
  const narrow = text.length - wide
  return Math.ceil(wide + narrow / 4)
}
