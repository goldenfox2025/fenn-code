import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspaces, isInside } from '../src/main/backends/workspace'

const tmp = () => mkdtempSync(join(tmpdir(), 'oc-ws-'))

describe('working folder', () => {
  it('knows what is inside a folder', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c.txt')).toBe(true)
    expect(isInside('/a/b', 'c/d.txt')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '../x')).toBe(false)
  })

  it('reads and writes inside the folder without asking, asks outside it', async () => {
    const root = tmp()
    const outside = join(tmp(), 'secret.txt')
    writeFileSync(outside, 'x')
    const asked: string[] = []
    let answer = false
    const ws = new Workspaces(async (_s, _title, detail) => (asked.push(detail), answer))
    ws.setRoot('s1', root)
    await ws.writeTextFile('s1', 'note.txt', 'a\nb\nc')
    expect(await ws.readTextFile('s1', join(root, 'note.txt'), 2, 1)).toBe('b')
    expect(asked).toEqual([])
    await expect(ws.writeTextFile('s1', outside, 'y')).rejects.toThrow()
    expect(asked).toEqual([outside])
    expect(readFileSync(outside, 'utf8')).toBe('x')
    answer = true
    await ws.writeTextFile('s1', outside, 'y')
    expect(readFileSync(outside, 'utf8')).toBe('y')
  })

  it('runs commands only with a folder, inside it', async () => {
    const root = tmp()
    const ws = new Workspaces(async () => true)
    await expect(ws.createTerminal('none', { command: 'echo hi' })).rejects.toThrow(/工作文件夹/) // i18n-ignore
    ws.setRoot('s1', root)
    await expect(ws.createTerminal('s1', { command: 'echo hi', cwd: '..' })).rejects.toThrow()
    writeFileSync(join(root, 'here.txt'), '')
    const id = await ws.createTerminal('s1', { command: process.platform === 'win32' ? 'dir /b' : 'ls' })
    expect((await ws.waitForExit(id)).exitCode).toBe(0)
    expect(ws.output(id).output).toContain('here.txt')
    ws.close('s1')
    expect(() => ws.output(id)).toThrow()
  })

  it('keeps the end of long output', async () => {
    const ws = new Workspaces(async () => true)
    ws.setRoot('s1', tmp())
    const id = await ws.createTerminal('s1', { command: 'node', args: ['-e', 'for(let i=0;i<2000;i++)console.log("line"+i)'], outputByteLimit: 200 })
    await ws.waitForExit(id)
    const out = ws.output(id)
    expect(out.truncated).toBe(true)
    expect(out.output).toContain('line1999')
    expect(Buffer.byteLength(out.output)).toBeLessThanOrEqual(200)
  })
})

describe('symlinks in the working folder', () => {
  it('asks before reading or writing through a link that points outside', async () => {
    const { symlinkSync, mkdirSync } = await import('node:fs')
    const root = tmp()
    const outsideDir = tmp()
    writeFileSync(join(outsideDir, 'secret.txt'), 'x')
    symlinkSync(outsideDir, join(root, 'link'), 'dir')
    symlinkSync(join(outsideDir, 'secret.txt'), join(root, 'file-link'))
    mkdirSync(join(root, 'sub'))
    const asked: string[] = []
    const ws = new Workspaces(async (_s, _t, detail) => (asked.push(detail), false))
    ws.setRoot('s1', root)
    await expect(ws.readTextFile('s1', 'link/secret.txt')).rejects.toThrow()
    await expect(ws.readTextFile('s1', 'file-link')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'link/new.txt', 'y')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'link/deeper/new.txt', 'y')).rejects.toThrow()
    await expect(ws.createTerminal('s1', { command: 'ls', cwd: 'link' })).rejects.toThrow()
    expect(asked).toHaveLength(4)
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('x')
    // Ordinary files and new files inside the folder still need no question.
    await ws.writeTextFile('s1', 'sub/ok.txt', 'fine')
    await ws.writeTextFile('s1', 'brand-new.txt', 'fine')
    expect(asked).toHaveLength(4)
  })

  it('works when the folder itself is reached through a link', async () => {
    const { symlinkSync } = await import('node:fs')
    const real = tmp()
    const alias = join(tmp(), 'alias')
    symlinkSync(real, alias, 'dir')
    const ws = new Workspaces(async () => false)
    ws.setRoot('s1', alias)
    await ws.writeTextFile('s1', 'a.txt', 'ok')
    expect(readFileSync(join(real, 'a.txt'), 'utf8')).toBe('ok')
  })
})

describe('dangling symlinks', () => {
  it('asks before writing through a link whose target outside does not exist yet', async () => {
    const { symlinkSync, existsSync } = await import('node:fs')
    const root = tmp()
    const outside = join(tmp(), 'planted.txt')
    const outsideDir = join(tmp(), 'not-yet')
    symlinkSync(outside, join(root, 'notes.txt'))
    symlinkSync(outsideDir, join(root, 'out'))
    // A chain: link → link → outside.
    symlinkSync(join(root, 'notes.txt'), join(root, 'chain.txt'))
    const asked: string[] = []
    const ws = new Workspaces(async (_s, _t, detail) => (asked.push(detail), false))
    ws.setRoot('s1', root)
    await expect(ws.writeTextFile('s1', 'notes.txt', 'x')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'chain.txt', 'x')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'out/a.txt', 'x')).rejects.toThrow()
    expect(asked).toHaveLength(3)
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(outsideDir)).toBe(false)
  })

  it('still allows a dangling link that points inside the folder', async () => {
    const { symlinkSync, readFileSync: read } = await import('node:fs')
    const root = tmp()
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
    const ws = new Workspaces(async () => false)
    ws.setRoot('s1', root)
    await ws.writeTextFile('s1', 'alias.txt', 'ok')
    expect(read(join(root, 'real.txt'), 'utf8')).toBe('ok')
  })

  it('gives up on link loops instead of hanging', async () => {
    const { symlinkSync } = await import('node:fs')
    const root = tmp()
    symlinkSync(join(root, 'b'), join(root, 'a'))
    symlinkSync(join(root, 'a'), join(root, 'b'))
    const ws = new Workspaces(async () => false)
    ws.setRoot('s1', root)
    await expect(ws.writeTextFile('s1', 'a', 'x')).rejects.toThrow()
  })
})

describe('.. after a symlinked folder', () => {
  it('applies .. to the real folder, as the OS does, not to the spelling', async () => {
    const { symlinkSync, mkdirSync, existsSync } = await import('node:fs')
    const base = tmp()
    const root = join(base, 'proj')
    const out = join(base, 'out')
    mkdirSync(root)
    mkdirSync(join(out, 'sub'), { recursive: true })
    symlinkSync(join(out, 'sub'), join(root, 'outdir'))
    // Spelled inside (proj/dotdot.txt), really out/dotdot.txt.
    symlinkSync('outdir/../dotdot.txt', join(root, 'dotdot'))
    const asked: string[] = []
    const ws = new Workspaces(async (_s, _t, detail) => (asked.push(detail), false))
    ws.setRoot('s1', root)
    await expect(ws.writeTextFile('s1', 'dotdot', 'x')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'outdir/../escape.txt', 'x')).rejects.toThrow()
    await expect(ws.createTerminal('s1', { command: 'ls', cwd: 'outdir/..' })).rejects.toThrow()
    expect(asked).toEqual([join(out, 'dotdot.txt'), join(out, 'escape.txt')])
    expect(existsSync(join(out, 'dotdot.txt'))).toBe(false)
    // Plain .. that stays inside still works without asking, and new folders appear.
    await ws.writeTextFile('s1', 'a/b/../c.txt', 'ok')
    expect(existsSync(join(root, 'a', 'c.txt'))).toBe(true)
    expect(asked).toHaveLength(2)
  })
})
