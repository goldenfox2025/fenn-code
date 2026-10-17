import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addFile, changedFiles, inside, listFolder, readPreview } from '../src/main/core/Library'
import type { Message } from '../src/shared/model'

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'lib-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'README.md'), '# hi\n')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
  return root
}

const tool = (paths: string[], toolKind = 'edit', status = 'completed', createdAt = 1): Message => ({
  id: 'm' + createdAt,
  conversationId: 'c',
  role: 'assistant',
  createdAt,
  blocks: [{ type: 'tool', toolId: 't' + createdAt, title: 'edit', toolKind, status: status as any, paths }]
})

describe('the files panel', () => {
  it('lists folders first, hides dotfiles, and never leaves the folder', () => {
    const root = folder()
    expect(listFolder(root)!.entries.map((e) => e.name)).toEqual(['src', 'bin.dat', 'README.md'])
    expect(listFolder(root, 'src')!.entries[0]).toMatchObject({ name: 'a.ts', path: 'src/a.ts', dir: false })
    expect(listFolder(root, '..')).toBeUndefined()
    expect(inside(root, '/etc')).toBeUndefined()
    expect(inside(root, 'src/../../x')).toBeUndefined()
    const outside = mkdtempSync(join(tmpdir(), 'out-'))
    symlinkSync(outside, join(root, 'link'))
    expect(inside(root, 'link')).toBeUndefined()
  })

  it('previews text and images, not binaries', () => {
    const root = folder()
    expect(readPreview(root, 'README.md')!.text).toBe('# hi\n')
    expect(readPreview(root, 'bin.dat')!.binary).toBe(true)
    expect(readPreview(root, '../etc/passwd')).toBeUndefined()
  })

  it('marks the files agents changed, latest change first, inside the folder only', () => {
    const root = folder()
    const changes = changedFiles(root, [
      tool([join(root, 'README.md')], 'edit', 'completed', 1),
      tool(['src/a.ts'], 'edit', 'completed', 3),
      tool([join(root, 'README.md')], 'edit', 'completed', 2),
      tool([join(root, 'gone.md')], 'delete', 'completed', 4),
      tool(['/elsewhere/x.md'], 'edit', 'completed', 5),
      tool([join(root, 'src', 'a.ts')], 'read', 'completed', 6),
      tool([join(root, 'failed.md')], 'edit', 'failed', 7)
    ])
    expect(changes.map((c) => [c.path, c.changedAt, c.exists])).toEqual([
      ['gone.md', 4, false],
      ['src/a.ts', 3, true],
      ['README.md', 2, true]
    ])
  })

  it('finds files made before the chat had its folder', () => {
    const root = folder()
    expect(changedFiles(root, [tool(['/data/workspaces/c1/README.md'])], ['/data/workspaces/c1']).map((c) => c.path)).toEqual(['README.md'])
  })

  it('adds files under a free name', () => {
    const root = folder()
    addFile(root, '', 'README.md', Buffer.from('x'))
    expect(listFolder(root)!.entries.map((e) => e.name)).toContain('README (2).md')
    expect(addFile(root, '..', 'x.md', Buffer.from('x'))).toBeUndefined()
  })
})
