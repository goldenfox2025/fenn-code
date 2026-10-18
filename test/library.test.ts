import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addFile, changedFiles, createEntry, fileName, inside, listFolder, readPreview, removablePath, renameEntry, writeText } from '../src/main/core/Library'
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

  it('renames in place, never onto another file or out of the folder', () => {
    const root = folder()
    expect(renameEntry(root, 'README.md', 'notes.md')).toEqual({ path: 'notes.md' })
    expect(existsSync(join(root, 'notes.md'))).toBe(true)
    expect(renameEntry(root, 'src', 'lib')).toEqual({ path: 'lib' })
    expect(readFileSync(join(root, 'lib', 'a.ts'), 'utf8')).toContain('a = 1')
    expect(renameEntry(root, 'lib/a.ts', 'b.ts')).toEqual({ path: 'lib/b.ts' })
    expect(renameEntry(root, 'notes.md', 'bin.dat')).toEqual({ refused: 'taken' })
    expect(renameEntry(root, 'notes.md', '../x.md')).toEqual({ refused: 'name' })
    expect(renameEntry(root, 'notes.md', 'CON')).toEqual({ refused: 'name' })
    expect(renameEntry(root, 'gone.md', 'x.md')).toEqual({ refused: 'gone' })
    expect(renameEntry(root, '', 'x')).toEqual({ refused: 'gone' })
    expect(renameEntry(root, '../x', 'y')).toEqual({ refused: 'gone' })
  })

  it('makes new files and folders under names not taken', () => {
    const root = folder()
    expect(createEntry(root, '', 'docs', true)).toEqual({ path: 'docs' })
    expect(createEntry(root, 'docs', 'plan.md', false)).toEqual({ path: 'docs/plan.md' })
    expect(readPreview(root, 'docs/plan.md')).toMatchObject({ text: '', size: 0 })
    expect(createEntry(root, 'docs', 'plan.md', false)).toEqual({ refused: 'taken' })
    expect(createEntry(root, '', 'a:b', false)).toEqual({ refused: 'name' })
    expect(createEntry(root, '..', 'x', false)).toEqual({ refused: 'gone' })
    expect(fileName('  ok.txt ')).toBe('ok.txt')
    expect([fileName('x.'), fileName('..'), fileName('a/b'), fileName('nul.txt')]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('saves edits, but not over a change made since the file was read', () => {
    const root = folder()
    const read = readPreview(root, 'README.md')!
    const saved = writeText(root, 'README.md', '# edited\n', read.updatedAt)
    expect(saved).toHaveProperty('updatedAt')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# edited\n')
    // An agent writes it meanwhile.
    utimesSync(join(root, 'README.md'), new Date(), new Date(Date.now() + 5000))
    expect(writeText(root, 'README.md', 'mine', (saved as { updatedAt: number }).updatedAt)).toEqual({ refused: 'changed' })
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# edited\n')
    expect(writeText(root, 'README.md', 'mine', 0, true)).toHaveProperty('updatedAt')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('mine')
    expect(writeText(root, 'gone.md', 'x')).toEqual({ refused: 'gone' })
    expect(writeText(root, '../out.md', 'x')).toEqual({ refused: 'gone' })
    expect(statSync(join(root, 'src')).isDirectory()).toBe(true)
    expect(writeText(root, 'src', 'x')).toEqual({ refused: 'gone' })
  })

  it('never writes, renames or deletes through a link or outside the folder, nor the folder itself', () => {
    const root = folder()
    const outside = mkdtempSync(join(tmpdir(), 'lib-out-'))
    writeFileSync(join(outside, 'x.txt'), 'outside\n')
    symlinkSync(outside, join(root, 'evil'))
    symlinkSync(join(outside, 'x.txt'), join(root, 'link.txt'))
    symlinkSync(join(outside, 'missing.txt'), join(root, 'dangling.txt'))
    expect(writeText(root, 'evil/x.txt', 'pwned', undefined, true)).toEqual({ refused: 'gone' })
    expect(writeText(root, 'link.txt', 'pwned', undefined, true)).toEqual({ refused: 'gone' })
    expect(writeText(root, 'dangling.txt', 'pwned', undefined, true)).toEqual({ refused: 'gone' })
    expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('outside\n')
    expect(existsSync(join(outside, 'missing.txt'))).toBe(false)
    expect(createEntry(root, 'evil', 'new.txt', false)).toEqual({ refused: 'gone' })
    expect(createEntry(root, '', 'dangling.txt', false)).toEqual({ refused: 'taken' })
    expect(addFile(root, '', 'dangling.txt', Buffer.from('x'))).toBe(join(root, 'dangling (2).txt'))
    expect(existsSync(join(outside, 'missing.txt'))).toBe(false)
    for (const rel of ['', '.', '..', '../' + root.split('/').pop(), 'src/..', 'evil/x.txt', '/etc/passwd']) expect(removablePath(root, rel)).toBeUndefined()
    expect(removablePath(root, 'dangling.txt')).toBe(join(root, 'dangling.txt'))
    expect(removablePath(root, 'evil')).toBe(join(root, 'evil'))
    expect(renameEntry(root, '.', 'x')).toEqual({ refused: 'gone' })
    expect(renameEntry(root, 'dangling.txt', 'gone.txt')).toEqual({ path: 'gone.txt' })
  })

  it('shows text in another encoding read-only and never saves over it; keeps a byte-order mark', () => {
    const root = folder()
    // 「中文」 in GBK.
    writeFileSync(join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]))
    const r = readPreview(root, 'gbk.txt')!
    expect(r).toMatchObject({ text: '中文\r\n', readOnly: true })
    expect(writeText(root, 'gbk.txt', '中文\r\n', r.updatedAt, true)).toEqual({ refused: 'encoding' })
    expect(readFileSync(join(root, 'gbk.txt'))).toEqual(Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]))
    writeFileSync(join(root, 'bom.txt'), '\uFEFFhello\r\n')
    const b = readPreview(root, 'bom.txt')!
    expect(b.text).toBe('hello\r\n')
    writeText(root, 'bom.txt', 'bye\r\n', b.updatedAt)
    expect(readFileSync(join(root, 'bom.txt'), 'utf8')).toBe('\uFEFFbye\r\n')
  })
})
