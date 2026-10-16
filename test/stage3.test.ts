import { describe, expect, it } from 'vitest'
import { applyPatch, progressCount, progressText, removeItem, resolveItem, statusOf } from '../src/main/core/progress'
import type { ProgressItem } from '../src/shared/model'
import { makeCore, until } from './helpers'

describe('progress board data', () => {
  it('nests tasks under milestones and rolls their status up', () => {
    let items: ProgressItem[] = []
    const m = applyPatch(items, { title: '上线第一版' }, 'user', 1)
    items = m.items
    expect(m.item.status).toBe('todo')
    items = applyPatch(items, { parentId: m.item.id, title: '写安装说明', status: 'doing' }, 'agent', 2).items
    expect(items[0].status).toBe('doing')
    const task = items[0].children![0]
    // Adding under a task adds beside it, one level down only.
    items = applyPatch(items, { parentId: task.id, title: '打包' }, 'user', 3).items
    expect(items[0].children!.map((c) => c.title)).toEqual(['写安装说明', '打包'])
    items = applyPatch(items, { id: task.id, status: 'done' }, 'user', 4).items
    items = applyPatch(items, { id: items[0].children![1].id, status: 'done' }, 'user', 5).items
    expect(items[0].status).toBe('done')
    expect(progressCount(items)).toEqual({ done: 2, total: 2 })
    items = applyPatch(items, { id: task.id, status: 'blocked' }, 'user', 6).items
    expect(items[0].status).toBe('blocked')
    items = removeItem(items, task.id)
    expect(items[0].status).toBe('done')
    expect(progressText(items)).toContain('✓ 上线第一版')
  })

  it('rejects bad input and understands loose wording', () => {
    expect(() => applyPatch([], { title: 'x', due: '下周五' }, 'user')).toThrow(/YYYY-MM-DD/)
    expect(() => applyPatch([], {}, 'user')).toThrow(/标题/)
    expect(() => applyPatch([], { id: 'nope', status: 'done' }, 'user')).toThrow()
    expect(statusOf('In Progress')).toBe('doing')
    expect(statusOf('完成')).toBe('done')
    expect(statusOf('maybe')).toBeUndefined()
    const { items } = applyPatch([], { title: 'Alpha' }, 'user')
    expect(resolveItem(items, 'alpha')?.title).toBe('Alpha')
    expect(resolveItem(items, items[0].id.slice(0, 4))?.title).toBe('Alpha')
  })

  it('does not count suggestions until accepted', () => {
    const { items } = applyPatch([], { title: '整理文档', status: 'done', suggested: true }, 'app')
    expect(progressCount(items)).toEqual({ done: 0, total: 0 })
    const accepted = applyPatch(items, { id: items[0].id, suggested: false }, 'user').items
    expect(progressCount(accepted)).toEqual({ done: 1, total: 1 })
  })
})

describe('progress board in a project', () => {
  it('lets the agent record work, linked to the chat that did it, without duplicates', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: '发布', backendId: 'mock' })
    const c = await core.startChat({ text: '#进度 发布 v1 / 写安装说明', backendId: 'mock', projectId: p.id })
    await until(() => store.project(p.id)?.progress?.[0]?.children?.length)
    await until(() => store.conversation(c.id)?.status === 'idle')
    await core.send(c.id, '#进度 发布 v1 / 打包')
    await until(() => store.project(p.id)?.progress?.[0]?.children?.length === 2)
    const board = store.project(p.id)!.progress!
    expect(board).toHaveLength(1)
    // All its tasks are done, so the milestone is too.
    expect(board[0]).toMatchObject({ title: '发布 v1', status: 'done', by: 'agent' })
    expect(board[0].children!.map((x) => [x.title, x.status])).toEqual([['写安装说明', 'done'], ['打包', 'done']])
    expect(board[0].children![0].links).toEqual([c.id])
    await dispose()
  }, 30000)

  it('suggests a done item for a finished thread the agent never recorded', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    await core.chat.send(p.conversationId, '帮我整理文档，完成后解决')
    const t = await until(() => store.conversations.find((c) => c.kind === 'thread' && c.resolved))
    const item = await until(() => store.project(p.id)?.progress?.[0])
    expect(item).toMatchObject({ title: t.title, status: 'done', suggested: true, links: [t.id], by: 'app' })
    // Ignoring it removes it, and it is not offered again.
    await core.deleteProgress(p.id, item.id)
    await core.send(t.id, '再补充一点，完成后解决')
    await until(() => store.conversation(t.id)?.resolved)
    await new Promise((r) => setTimeout(r, 300))
    expect(store.project(p.id)!.progress).toEqual([])
    await dispose()
  }, 30000)

  it('archives and restores a project, and edits by hand', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'y', backendId: 'mock' })
    await core.updateProject(p.id, { archived: true })
    expect(store.project(p.id)!.archived).toBe(true)
    await core.updateProject(p.id, { archived: false })
    expect(store.project(p.id)!.archived).toBe(false)
    const m = await core.updateProgress(p.id, { title: '里程碑', due: '2026-11-01' })
    await core.updateProgress(p.id, { id: m.id, note: '先做设计' })
    expect(store.project(p.id)!.progress![0]).toMatchObject({ title: '里程碑', due: '2026-11-01', note: '先做设计', by: 'user' })
    await expect(core.updateProgress(p.id, { title: 'z', due: 'bad' })).rejects.toThrow()
    await dispose()
  }, 30000)

  it('pauses a project’s routines while it is archived, and only those archiving paused', async () => {
    const { core, store, dispose } = await makeCore()
    const p = await core.createProject({ name: 'r', backendId: 'mock' })
    const on = await core.saveRoutine({ name: '日报', prompt: '总结', schedule: { kind: 'interval', minutes: 1 }, target: { projectId: p.id }, enabled: true })
    const off = await core.saveRoutine({ name: '周报', prompt: '总结', schedule: { kind: 'interval', minutes: 60 }, target: { projectId: p.id }, enabled: false })
    const other = await core.saveRoutine({ name: '别处', prompt: '你好', schedule: { kind: 'interval', minutes: 60 }, target: {}, enabled: true })
    const get = (id: string) => store.routines.find((r) => r.id === id)!
    await core.updateProject(p.id, { archived: true })
    expect(get(on.id)).toMatchObject({ enabled: false, pausedByArchive: true, nextRunAt: undefined })
    expect(get(off.id).pausedByArchive).toBeUndefined()
    expect(get(other.id).enabled).toBe(true)
    await core.updateProject(p.id, { archived: false })
    expect(get(on.id).enabled).toBe(true)
    expect(get(on.id).pausedByArchive).toBeUndefined()
    expect(get(on.id).nextRunAt).toBeGreaterThan(Date.now())
    expect(get(off.id).enabled).toBe(false)
    await dispose()
  }, 30000)
})
