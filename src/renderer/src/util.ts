import type { Block, Conversation, Message, WorkStatus } from '@shared/model'
import { locale, t } from './i18n'

export function textOf(m: Message): string {
  return m.blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export function greeting(name: string): string {
  const h = new Date().getHours()
  const part = h < 5 ? t('夜深了') : h < 11 ? t('早上好') : h < 13 ? t('中午好') : h < 18 ? t('下午好') : t('晚上好')
  return name ? t('{0}，{1}', part, name) : part
}

export function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (days === 0) return t('今天')
  if (days === 1) return t('昨天')
  if (days < 7) return t('{0} 天前', days)
  return d.toLocaleDateString(locale, { month: 'long', day: 'numeric' })
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{0} 分钟前', Math.floor(s / 60))
  if (s < 86400) return t('{0} 小时前', Math.floor(s / 3600))
  return dayLabel(ts)
}

export const STATUS_LABEL: Record<WorkStatus, string> = {
  idle: t('空闲'),
  working: t('进行中'),
  waiting: t('等待您'),
  done: t('已完成'),
  error: t('出错')
}

export function threadState(c: Conversation): 'working' | 'waiting' | 'done' | 'error' {
  if (c.status === 'working') return 'working'
  if (c.status === 'error') return 'error'
  if (c.resolved || c.status === 'done') return 'done'
  return 'waiting'
}

export function initials(name: string): string {
  return (name || t('您')).trim().slice(0, 1).toUpperCase()
}

/** A running time, short: 45秒, 3分钟, 2小时. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('{0}秒', s)
  if (s < 3600) return t('{0}分钟', Math.floor(s / 60))
  return t('{0}小时', Math.floor(s / 3600))
}

/**
 * True while an input method is composing (Chinese, Japanese...): Enter picks a
 * candidate and Esc dismisses the candidates, so neither may submit or close.
 */
export function imeComposing(e: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const n = 'nativeEvent' in e ? e.nativeEvent : e
  return n.isComposing || n.keyCode === 229
}

/** A time to the minute, never the seconds: 10月18日 09:00, with the year only when it isn't this one. */
export function minuteTime(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const year = d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}
  return d.toLocaleString(locale, { ...year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
