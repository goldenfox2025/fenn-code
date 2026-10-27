import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store/Store'
import { makeCore } from './helpers'

it('no longer advertises home widgets to agents', async () => {
  const { core, dispose } = await makeCore()
  try {
    const chat = core.chat.createConversation({ kind: 'chat', title: 'chat', backendId: 'mock' })
    expect(core.orchestrator.extraTools!(chat).map(tool => tool.name)).not.toContain('home_board')
  } finally { await dispose() }
})

it('retires invisible widget refreshes while preserving ordinary schedules and saved data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fenn-retired-widgets-'))
  const ordinary = { id: 'ordinary', enabled: true, nextRunAt: 123, target: {}, schedule: { kind: 'daily', time: '09:00' } }
  const card = { id: 'legacy', title: 'Saved data', body: { kind: 'markdown', text: 'Keep this content' } }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: {}, boardWidgets: [card], routines: [{ ...ordinary, id: 'widget', widgetId: card.id }, ordinary] }))
  const store = new Store(dir)
  expect(store.routines.find(r => r.id === 'widget')).toMatchObject({ enabled: false, nextRunAt: undefined })
  expect(store.routines.find(r => r.id === 'ordinary')).toEqual(ordinary)
  expect(store.boardWidgets).toEqual([card])
  store.flush()
  const reopened = new Store(dir)
  expect(reopened.routines.find(r => r.id === 'widget')?.enabled).toBe(false)
})
