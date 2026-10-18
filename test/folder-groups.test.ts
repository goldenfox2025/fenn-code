import { beforeAll, describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'

// The renderer's i18n reads the page's language when loaded.
let groupByFolder: typeof import('../src/renderer/src/folderGroups').groupByFolder
beforeAll(async () => {
  Object.assign(globalThis, { document: { documentElement: {} } })
  groupByFolder = (await import('../src/renderer/src/folderGroups')).groupByFolder
})

const chat = (id: string, updatedAt: number, extra: Partial<Conversation> = {}) =>
  ({ id, kind: 'chat', title: id, backendId: 'mock', createdAt: updatedAt, updatedAt, status: 'idle', ...extra }) as Conversation

describe('sidebar folder groups', () => {
  it('gives a folder the app chose for a chat its own header, which later chats in that folder join', () => {
    const groups = groupByFolder([
      chat('plain', 3),
      chat('auto', 2, { cwd: 'C:/Users/me/Documents/Fenn Code/Notes', autoFolder: true }),
      chat('same', 1, { cwd: 'C:/Users/me/Documents/Fenn Code/notes' })
    ])
    expect(groups.map((g) => [g.name, g.chats.map((c) => c.id)])).toEqual([
      [expect.any(String), ['plain']],
      ['Notes', ['auto', 'same']]
    ])
    expect(groups[1].folder).toBe('C:/Users/me/Documents/Fenn Code/Notes')
  })
})
