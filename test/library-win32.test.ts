import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Opening a file the way libuv does on Windows: no O_NOFOLLOW there, and O_TRUNC without O_CREAT is EINVAL.
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  const { O_TRUNC, O_CREAT, O_NOFOLLOW } = real.constants
  const openSync = (path: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode) => {
    if (typeof flags === 'number' && ((flags & O_TRUNC && !(flags & O_CREAT)) || (O_NOFOLLOW && flags & O_NOFOLLOW))) {
      throw Object.assign(new Error(`EINVAL: invalid argument, open '${String(path)}'`), { code: 'EINVAL' })
    }
    return real.openSync(path, flags, mode)
  }
  return { ...real, openSync, default: { ...real, openSync } }
})

const { readPreview, writeText } = await import('../src/main/core/Library')

describe('saving a file on Windows', () => {
  it('saves, cuts a shorter text to length, and keeps line ends and the byte-order mark', () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-win-'))
    writeFileSync(join(root, 'crlf-test.txt'), '\uFEFFone\r\ntwo\r\nthree\r\n')
    // How 0.1.2's first builds opened it: refused, as on the PC.
    expect(() => fs.openSync(join(root, 'crlf-test.txt'), fs.constants.O_WRONLY | fs.constants.O_TRUNC)).toThrow('EINVAL')
    const r = readPreview(root, 'crlf-test.txt')!
    expect(writeText(root, 'crlf-test.txt', 'one\r\n2\r\n', r.updatedAt, false, 'win32')).toHaveProperty('updatedAt')
    expect(readFileSync(join(root, 'crlf-test.txt'), 'utf8')).toBe('\uFEFFone\r\n2\r\n')
    writeFileSync(join(root, 'plan.md'), '# plan\n')
    expect(writeText(root, 'plan.md', '# plan\n\n- a longer list\n', undefined, false, 'win32')).toHaveProperty('updatedAt')
    expect(readFileSync(join(root, 'plan.md'), 'utf8')).toBe('# plan\n\n- a longer list\n')
  })

  it('never makes a file that is not there', () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-win-'))
    expect(writeText(root, 'new.md', 'x', undefined, true, 'win32')).toEqual({ refused: 'gone' })
    expect(fs.existsSync(join(root, 'new.md'))).toBe(false)
  })
})

describe('what the system says about a file', () => {
  it('is a sentence with the file name, not the code and the whole path', async () => {
    const { plainError } = await import('../src/shared/errors')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(plainError("EINVAL: invalid argument, open 'C:\\Users\\me\\Documents\\x\\crlf-test.txt'")).toBe('「crlf-test.txt」：系统没能完成这个操作。')
    expect(plainError('EBUSY: resource busy or locked')).toBe('它正被别的程序占用。')
    expect(plainError('没能保存「a.md」。')).toBe('没能保存「a.md」。')
    warn.mockRestore()
  })
})
