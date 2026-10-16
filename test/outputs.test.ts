import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseScheduleArgs } from '../src/main/core/AppCore'
import { makeCore, until } from './helpers'

describe('outputs agents hand over', () => {
  it('a project file the agent writes shows as a card and in the project library', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    const chat = core.chat.createConversation({ kind: 'thread', title: '结论', projectId: p.id, backendId: 'mock' })
    await core.send(chat.id, '交付文件 结论.md')
    const reply = await until(() => store.messagesOf(chat.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    const card = reply.blocks.find((b) => b.type === 'output')
    expect(card).toMatchObject({ type: 'output', kind: 'file', title: '结论.md' })
    expect(core.files.list(p.id).map((f) => f.name)).toEqual(['结论.md'])
    const lib = store.project(p.id)!.outputs!
    expect(lib).toHaveLength(1)
    expect(lib[0]).toMatchObject({ kind: 'file', title: '结论.md', conversationId: chat.id, messageId: reply.id })
    await dispose()
  }, 30000)

  it('attaches existing files and links, and refuses what is not there', async () => {
    const { core, store, dispose } = await makeCore()
    const dir = mkdtempSync(join(tmpdir(), 'out-'))
    writeFileSync(join(dir, 'report.pdf'), 'pdf')
    const a = await core.startChat({ text: `附上 ${join(dir, 'report.pdf')}`, backendId: 'mock' })
    const r1 = await until(() => store.messagesOf(a.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    expect(r1.blocks.find((b) => b.type === 'output')).toMatchObject({ kind: 'file', title: 'report.pdf', size: 3 })
    const b = await core.startChat({ text: '附上链接 https://example.com/doc', backendId: 'mock' })
    const r2 = await until(() => store.messagesOf(b.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    expect(r2.blocks.find((x) => x.type === 'output')).toMatchObject({ kind: 'link', url: 'https://example.com/doc', title: '需求文档' })
    const c = await core.startChat({ text: `附上 ${join(dir, 'missing.pdf')}`, backendId: 'mock' })
    const r3 = await until(() => store.messagesOf(c.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    expect(r3.blocks.some((x) => x.type === 'output')).toBe(false)
    // Programs are never launched from a card; only shown in their folder.
    const opened: [string, boolean][] = []
    core.shellOpen = async (p, reveal) => void opened.push([p, reveal])
    writeFileSync(join(dir, 'setup.exe'), 'x')
    await core.openOutput(join(dir, 'report.pdf'))
    await core.openOutput(join(dir, 'setup.exe'))
    expect(opened).toEqual([
      [join(dir, 'report.pdf'), false],
      [join(dir, 'setup.exe'), true]
    ])
    expect(await core.openOutput(join(dir, 'gone.pdf'))).toMatchObject({ ok: false })
    await dispose()
  }, 30000)
})

describe('routines agents create', () => {
  it('creates a daily routine posting back here, and lists it', async () => {
    const { core, store, dispose } = await makeCore()
    const chat = await core.startChat({ text: '每天提醒我看日报', backendId: 'mock' })
    const reply = await until(() => store.messagesOf(chat.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    const r = store.routines.find((x) => x.createdBy === chat.id)!
    expect(r).toMatchObject({ name: '每日提醒', schedule: { kind: 'daily', time: '09:00' }, target: { conversationId: chat.id }, enabled: true })
    expect(r.nextRunAt).toBeGreaterThan(Date.now())
    expect(reply.blocks.some((b) => b.type === 'notice' && b.text.includes('已创建定时任务「每日提醒」'))).toBe(true)
    await dispose()
  }, 30000)

  it('a routine running unattended cannot set up more routines', async () => {
    const { core, store, dispose } = await makeCore()
    const chat = await core.startChat({ text: '你好', backendId: 'mock' })
    await until(() => store.messagesOf(chat.id).find((m) => m.role === 'assistant' && m.state === 'done'))
    const r = await core.saveRoutine({
      name: '套娃',
      prompt: '每天提醒我看日报',
      schedule: { kind: 'daily', time: '09:00' },
      target: { conversationId: chat.id },
      backendId: 'mock',
      enabled: true
    })
    await core.runRoutineNow(r.id)
    await until(() => store.messagesOf(chat.id).filter((m) => m.role === 'assistant' && m.state === 'done').length >= 2)
    expect(store.routines.map((x) => x.name)).toEqual(['套娃'])
    await dispose()
  }, 30000)

  it('parses schedules and rejects bad ones', () => {
    const now = Date.parse('2026-10-15T00:00:00Z')
    expect(parseScheduleArgs({ schedule: 'once', at: '2026-10-16T09:00:00+08:00' }, now)).toEqual({ kind: 'once', at: Date.parse('2026-10-16T01:00:00Z') })
    expect(parseScheduleArgs({ schedule: 'interval', minutes: 30 }, now)).toEqual({ kind: 'interval', minutes: 30 })
    expect(parseScheduleArgs({ schedule: 'weekly', time: '9:30', weekdays: [5, 1, 1] }, now)).toEqual({ kind: 'daily', time: '09:30', weekdays: [1, 5] })
    expect(parseScheduleArgs({ schedule: 'cron', cron: '0 9 * * 1-5' }, now)).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' })
    expect(() => parseScheduleArgs({ schedule: 'once', at: '2020-01-01T00:00:00Z' }, now)).toThrow('过去')
    expect(() => parseScheduleArgs({ schedule: 'interval', minutes: 1 }, now)).toThrow('至少 5')
    expect(() => parseScheduleArgs({ schedule: 'daily', time: '25:00' }, now)).toThrow('HH:MM')
    expect(() => parseScheduleArgs({ schedule: 'cron', cron: 'nope' }, now)).toThrow('cron')
  })
})
