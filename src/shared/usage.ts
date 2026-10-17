/**
 * Token and cost bookkeeping. Only numbers a backend actually reported are
 * added up; turns it reported nothing for are counted separately, never guessed.
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

/**
 * A stream shorter than this says little about speed: an agent that buffers its output
 * hands over hundreds of tokens in a few milliseconds, which would read as thousands per second.
 */
export const MIN_STREAM_MS = 1000

/** One reply's usage: the tokens the backend reported, and what the turn cost if it said. */
export interface MessageUsage extends TurnUsage {
  cost?: Cost
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
  /** Finished turns the backend reported no usage for. */
  unreported: number
  cost?: Cost
  /** Turns whose cost was in a different currency than `cost`, so not added in. */
  costSkipped?: number
  /** The context window as last reported (conversations only). */
  contextUsed?: number
  contextSize?: number
  /** Where contextUsed came from: the agent over ACP, or its own session log. */
  contextSource?: 'agent' | 'log'
  /** Where contextSize came from; 'table' is the bundled model-limit table. */
  contextSizeSource?: 'agent' | 'log' | 'table'
}

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, total: 0, turns: 0, unreported: 0 })

const add = (a: number | undefined, b: number | undefined): number | undefined => (b === undefined ? a : (a ?? 0) + b)

function addCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
  if (!b) return a
  if (!a) return { ...b }
  // Mixed currencies can't be summed; keep the first.
  return a.currency === b.currency ? { amount: a.amount + b.amount, currency: a.currency } : a
}

/**
 * The tokens a turn is shown as: new input plus output. Some agents' own total
 * also counts cache reads, once per tool call (Claude Code's does), which
 * makes a few turns read as millions; cache figures stay in the details.
 */
export function headline(u: TurnUsage): number {
  return u.input !== undefined || u.output !== undefined ? (u.input ?? 0) + (u.output ?? 0) : (u.total ?? 0)
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
  x.total += headline(u)
  x.thought = add(x.thought, u.thought)
  x.cachedRead = add(x.cachedRead, u.cachedRead)
  x.cachedWrite = add(x.cachedWrite, u.cachedWrite)
  if (u.cost && x.cost && u.cost.currency !== x.cost.currency) x.costSkipped = (x.costSkipped ?? 0) + 1
  else x.cost = addCost(x.cost, u.cost)
  x.turns++
  return x
}

/** Takes one counted turn back out (its usage turned out to be another turn's), leaving it unreported. */
export function removeTurn(t: UsageTotals, u: MessageUsage): UsageTotals {
  const x = { ...t }
  const less = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? a : Math.max(0, a - b))
  x.input = Math.max(0, x.input - (u.input ?? 0))
  x.output = Math.max(0, x.output - (u.output ?? 0))
  x.total = Math.max(0, x.total - headline(u))
  x.thought = less(x.thought, u.thought)
  x.cachedRead = less(x.cachedRead, u.cachedRead)
  x.cachedWrite = less(x.cachedWrite, u.cachedWrite)
  if (u.cost && x.cost?.currency === u.cost.currency) x.cost = { ...x.cost, amount: Math.max(0, x.cost.amount - u.cost.amount) }
  x.turns = Math.max(0, x.turns - 1)
  x.unreported++
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

