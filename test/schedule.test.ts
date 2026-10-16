import { describe, expect, it } from 'vitest'
import { nextCron, nextRun } from '../src/main/core/schedule'
import { makeCore, until } from './helpers'

const at = (s: string) => new Date(s).getTime()

describe('schedules', () => {
  it('daily with weekdays', () => {
    // 2026-10-12 is a Monday
    const from = at('2026-10-12T10:00:00')
    expect(new Date(nextRun({ kind: 'daily', time: '09:00' }, from)!).toString()).toContain('Oct 13 2026 09:00')
    expect(new Date(nextRun({ kind: 'daily', time: '11:30' }, from)!).toString()).toContain('Oct 12 2026 11:30')
    expect(new Date(nextRun({ kind: 'daily', time: '09:00', weekdays: [5] }, from)!).toString()).toContain('Fri Oct 16 2026 09:00')
  })
  it('cron', () => {
    const from = at('2026-10-12T10:07:00')
    expect(new Date(nextCron('*/15 * * * *', from)!).toString()).toContain('10:15')
    expect(new Date(nextCron('0 9 * * 1-5', at('2026-10-16T10:00:00'))!).toString()).toContain('Mon Oct 19 2026 09:00')
    expect(new Date(nextCron('30 8 1 * *', from)!).toString()).toContain('Nov 01 2026 08:30')
    expect(() => nextCron('bad', from)).toThrow()
  })
  it('interval and once', () => {
    const from = at('2026-10-12T10:00:00')
    expect(nextRun({ kind: 'interval', minutes: 30 }, from)).toBe(from + 30 * 60000)
    expect(nextRun({ kind: 'once', at: from + 5 }, from)).toBe(from + 5)
    expect(nextRun({ kind: 'once', at: from + 5 }, from, from + 5)).toBeUndefined()
    // Run by hand before its time: it still runs at its time.
    expect(nextRun({ kind: 'once', at: from + 5 }, from, from)).toBe(from + 5)
  })
})

describe('scheduler', () => {
  it('runs a due routine into a project chat and reschedules', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    const r = await core.saveRoutine({ name: '早报', prompt: '帮我整理今日要闻', schedule: { kind: 'interval', minutes: 60 }, target: { projectId: p.id }, enabled: true })
    expect(r.nextRunAt).toBeGreaterThan(Date.now())
    await core.scheduler.tick(r.nextRunAt! + 1)
    const after = store.routines[0]
    expect(after.lastRunConversationId).toBe(p.conversationId)
    expect(after.nextRunAt).toBeGreaterThan(Date.now())
    await until(() => store.conversations.find((c) => c.kind === 'thread'))
    await dispose()
  }, 30000)

  it('one-off routine creates a chat and disables itself', async () => {
    const { core, store, dispose } = await makeCore()
    const r = await core.saveRoutine({ name: '提醒', prompt: '提醒我喝水', schedule: { kind: 'once', at: Date.now() - 1000 }, target: {}, backendId: 'mock', enabled: true })
    await core.scheduler.tick()
    const after = store.routines.find((x) => x.id === r.id)!
    expect(after.enabled).toBe(false)
    expect(store.conversation(after.lastRunConversationId)?.title).toContain('提醒')
    await dispose()
  }, 30000)
})
