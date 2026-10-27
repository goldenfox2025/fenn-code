import { describe, expect, it } from 'vitest'
import { libraryLocation, materialPath, MATERIALS } from '../src/renderer/src/components/files/librarySources'

describe('one library, distinct storage roots', () => {
  it('routes same-named working files and materials to distinct owners', () => {
    expect(libraryLocation('project', 'notes.md', true)).toEqual({ id: 'project', path: 'notes.md' })
    expect(libraryLocation('project', materialPath('notes.md'), true)).toEqual({ id: 'project-files:project', path: 'notes.md' })
  })
  it('resolves the materials root and nested paths without leaking the tree namespace', () => {
    expect(libraryLocation('project', MATERIALS, true)).toEqual({ id: 'project-files:project', path: '' })
    expect(libraryLocation('project', materialPath('参考/说明.md'), true).path).toBe('参考/说明.md')
  })
  it('leaves ordinary chats and direct material viewers unchanged', () => {
    expect(libraryLocation('chat', '@materials/notes.md', false)).toEqual({ id: 'chat', path: '@materials/notes.md' })
    expect(libraryLocation('project-files:p', 'notes.md', false)).toEqual({ id: 'project-files:p', path: 'notes.md' })
  })
})
