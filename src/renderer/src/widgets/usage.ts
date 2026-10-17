import { useEffect, useState } from 'react'
import type { UsageSummary } from '@shared/model'
import { api } from '../store'

/** Widgets shown together share one fetch; a page opened later fetches again. */
const FRESH_MS = 2000
let last: { at: number; summary: Promise<UsageSummary> } | undefined

function load(): Promise<UsageSummary> {
  if (!last || Date.now() - last.at > FRESH_MS)
    last = { at: Date.now(), summary: api().usageCalendar().catch(() => ({ days: [], models: [] })) }
  return last.summary
}

/** Tokens per day and per model from every conversation; null while it loads. */
export function useUsageSummary(): UsageSummary | null {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  useEffect(() => {
    let live = true
    void load().then((u) => live && setUsage(u))
    return () => {
      live = false
    }
  }, [])
  return usage
}

/** A local date as YYYY-MM-DD, the key UsageDay.day uses. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Midnight today, local time. */
export function today(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
