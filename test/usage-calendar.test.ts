import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store/Store'
import { UsageCalendar, dayKey } from '../src/main/core/UsageCalendar'
import type { Message } from '../src/shared/model'

const reply = (id: string, at: number, input: number, output: number): Message =>
  ({ id, conversationId: 'c', role: 'assistant', blocks: [], createdAt: at, state: 'done', usage: { input, output, cachedRead: 99999 } }) as Message

describe('the usage calendar', () => {
  it('adds up each day’s new input and output across chats, once per reply', async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), 'cal-')))
    const day = 86400000
    const now = new Date(2026, 9, 17, 12).getTime()
    store.putConversation({ id: 'c', kind: 'chat', title: 'x', backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now } as never)
    store.putMessage(reply('a', now - day, 100, 20))
    store.putMessage(reply('b', now - day + 1000, 50, 5))
    store.putMessage({ id: 'u', conversationId: 'c', role: 'user', blocks: [], createdAt: now } as Message)
    const cal = new UsageCalendar(store)
    expect(await cal.list()).toEqual([{ day: dayKey(now - day), tokens: 175, replies: 2 }])
    const late = reply('d', now, 10, 1)
    store.putMessage(late)
    cal.add(late)
    cal.add(late)
    expect(await cal.list()).toEqual([
      { day: dayKey(now - day), tokens: 175, replies: 2 },
      { day: dayKey(now), tokens: 11, replies: 1 }
    ])
  })
})
