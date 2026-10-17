import { useEffect, useState } from 'react'
import type { UsageSummary } from '@shared/model'
import { api, useApp } from '../store'

/** Widgets shown together share one fetch; a page opened later, or a chat deleted, fetches again. */
const FRESH_MS = 2000
let last: { at: number; chats: number; summary: Promise<UsageSummary> } | undefined

function load(chats: number): Promise<UsageSummary> {
  if (!last || last.chats !== chats || Date.now() - last.at > FRESH_MS)
    last = { at: Date.now(), chats, summary: api().usageCalendar().catch(() => ({ days: [], models: [] })) }
  return last.summary
}

/** Tokens per day and per model from every conversation; null while it first loads. */
export function useUsageSummary(): UsageSummary | null {
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const chats = useApp((s) => s.conversations.length)
  useEffect(() => {
    let live = true
    void load(chats).then((u) => live && setUsage(u))
    return () => {
      live = false
    }
  }, [chats])
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
