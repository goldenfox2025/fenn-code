import { expect, it } from 'vitest'
import { boardBody } from '../src/main/core/tools/boardTools'
import { makeCore } from './helpers'

const tool = (core: any, id: string) => core.orchestrator.toolsFor(id).find((t: { name: string }) => t.name === 'home_board')

it('an agent puts a card on the home board, replaces its data by id, and deletes it', async () => {
  const { core, store, dispose } = await makeCore()
  try {
    const conv = core.chat.createConversation({ kind: 'chat', title: '服务器', backendId: 'mock' })
    const board = tool(core, conv.id)
    expect(board).toBeTruthy()
    const out = await board.run({ action: 'put', title: '服务器状态', kind: 'stat', data: { items: [{ label: '在线', value: '3 台', tone: 'good' }] } }, { conversationId: conv.id })
    expect(out).toContain('已放到首页')
    const [w] = store.boardWidgets
    expect(w).toMatchObject({ title: '服务器状态', size: 'wide', createdBy: conv.id, body: { kind: 'stat', items: [{ label: '在线', value: '3 台', tone: 'good' }] } })
    expect(core.snapshot().boardWidgets).toHaveLength(1)
    // The same id: the whole card is replaced, not added to.
    await board.run({ action: 'put', id: w.id.slice(0, 8), kind: 'list', data: { items: ['重启 db', { text: '换证书', done: true }] } }, { conversationId: conv.id })
    expect(store.boardWidgets).toHaveLength(1)
    expect(store.boardWidgets[0].body).toEqual({ kind: 'list', items: [{ text: '重启 db' }, { text: '换证书', done: true }] })
    expect(store.boardWidgets[0].title).toBe('服务器状态')
    // An arranged home page gets the new card at its end, and loses it again on delete.
    await core.updateSettings({ homeWidgets: ['usage-stats'] })
    await board.run({ action: 'put', title: '笔记', kind: 'markdown', data: { text: '# 今天' } }, { conversationId: conv.id })
    const second = store.boardWidgets.find((x) => x.title === '笔记')!
    expect(store.settings.homeWidgets).toEqual(['usage-stats', `board:${second.id}`])
    await board.run({ action: 'remove', id: second.id }, { conversationId: conv.id })
    expect(store.settings.homeWidgets).toEqual(['usage-stats'])
    expect(await board.run({ action: 'list' }, { conversationId: conv.id })).toContain('服务器状态')
    await expect(board.run({ action: 'put', id: 'nope-nope', kind: 'markdown', data: { text: 'x' } }, { conversationId: conv.id })).rejects.toThrow('没有这张卡片')
  } finally {
    await dispose()
  }
})

it('a card refreshed by a routine: only that routine’s unattended run may update it, and deleting the card deletes the routine', async () => {
  const { core, store, dispose } = await makeCore()
  try {
    const conv = core.chat.createConversation({ kind: 'chat', title: '天气', backendId: 'mock' })
    const board = tool(core, conv.id)
    await board.run(
      { action: 'put', title: '天气', kind: 'stat', data: { items: [{ label: '气温', value: '20°' }] }, refresh: { prompt: '查北京天气', schedule: 'interval', minutes: 30 } },
      { conversationId: conv.id }
    )
    const w = store.boardWidgets[0]
    const r = store.routines.find((x) => x.id === w.routineId)!
    expect(r).toMatchObject({ widgetId: w.id, target: {}, schedule: { kind: 'interval', minutes: 30 } })
    expect(r.prompt).toContain(`id=${w.id}`)
    // A run of that routine is unattended, in a chat of its own.
    const run = core.chat.createConversation({ kind: 'chat', title: '天气 · run', backendId: 'mock', routineId: r.id })
    ;(core.chat as any).unattendedTurns.add(run.id)
    await tool(core, run.id).run({ action: 'put', id: w.id, kind: 'stat', data: { items: [{ label: '气温', value: '22°' }] } }, { conversationId: run.id })
    expect((store.boardWidgets[0].body as any).items[0].value).toBe('22°')
    await expect(tool(core, run.id).run({ action: 'put', title: '新卡', kind: 'markdown', data: { text: 'x' } }, { conversationId: run.id })).rejects.toThrow('只能更新')
    await expect(tool(core, run.id).run({ action: 'remove', id: w.id }, { conversationId: run.id })).rejects.toThrow('不能删除')
    await core.deleteBoardWidget(w.id)
    expect(store.routines.some((x) => x.id === r.id)).toBe(false)
  } finally {
    await dispose()
  }
})

it('card data is checked and cut to size', () => {
  expect(() => boardBody('stat', { items: [] })).toThrow('stat')
  expect(() => boardBody('chart', { labels: ['a', 'b'], series: [{ name: 'x', values: [1] }] })).toThrow('chart')
  expect(boardBody('chart', { labels: ['a', 'b'], series: [{ name: 'x', values: ['1', 2] }] })).toEqual({ kind: 'chart', style: 'bar', labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }], unit: undefined })
  expect(boardBody('html', { html: '<p>x</p>', height: 9999 })).toMatchObject({ height: 600 })
  expect(() => boardBody('video', {})).toThrow('kind')
})
