import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspaces, isInside, type AccessDecision } from '../src/main/backends/workspace'
import { link } from './links'

const tmp = () => mkdtempSync(join(tmpdir(), 'oc-ws-'))
// The user's answer to each question, by its detail.
const ask = (answer: (detail: string) => boolean) => ({
  ask: async (_s: string, _t: string, detail: string): Promise<AccessDecision> => (answer(detail) ? 'allow' : 'reject')
})

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
    const ws = new Workspaces(ask((d) => (asked.push(d), answer)))
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

  it('runs commands in its folder and asks before running one outside it', async () => {
    const root = tmp()
    const ws = new Workspaces(ask(() => false))
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
    const ws = new Workspaces(ask(() => true))
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
  it('asks before reading or writing through a link that points outside', async (ctx) => {
    const { mkdirSync } = await import('node:fs')
    const root = tmp()
    const outsideDir = tmp()
    writeFileSync(join(outsideDir, 'secret.txt'), 'x')
    link(ctx, outsideDir, join(root, 'link'), 'dir')
    link(ctx, join(outsideDir, 'secret.txt'), join(root, 'file-link'))
    mkdirSync(join(root, 'sub'))
    const asked: string[] = []
    const ws = new Workspaces(ask((d) => (asked.push(d), false)))
    ws.setRoot('s1', root)
    await expect(ws.readTextFile('s1', 'link/secret.txt')).rejects.toThrow()
    await expect(ws.readTextFile('s1', 'file-link')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'link/new.txt', 'y')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'link/deeper/new.txt', 'y')).rejects.toThrow()
    await expect(ws.createTerminal('s1', { command: 'ls', cwd: 'link' })).rejects.toThrow()
    expect(asked).toHaveLength(5)
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('x')
    // Ordinary files and new files inside the folder still need no question.
    await ws.writeTextFile('s1', 'sub/ok.txt', 'fine')
    await ws.writeTextFile('s1', 'brand-new.txt', 'fine')
    expect(asked).toHaveLength(5)
  })

  it('works when the folder itself is reached through a link', async (ctx) => {
    const real = tmp()
    const alias = join(tmp(), 'alias')
    link(ctx, real, alias, 'dir')
    const ws = new Workspaces(ask(() => false))
    ws.setRoot('s1', alias)
    await ws.writeTextFile('s1', 'a.txt', 'ok')
    expect(readFileSync(join(real, 'a.txt'), 'utf8')).toBe('ok')
  })
})

describe('dangling symlinks', () => {
  it('asks before writing through a link whose target outside does not exist yet', async (ctx) => {
    const { existsSync } = await import('node:fs')
    const root = tmp()
    const outside = join(tmp(), 'planted.txt')
    const outsideDir = join(tmp(), 'not-yet')
    link(ctx, outside, join(root, 'notes.txt'))
    link(ctx, outsideDir, join(root, 'out'), 'dir')
    // A chain: link → link → outside.
    link(ctx, join(root, 'notes.txt'), join(root, 'chain.txt'))
    const asked: string[] = []
    const ws = new Workspaces(ask((d) => (asked.push(d), false)))
    ws.setRoot('s1', root)
    await expect(ws.writeTextFile('s1', 'notes.txt', 'x')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'chain.txt', 'x')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'out/a.txt', 'x')).rejects.toThrow()
    expect(asked).toHaveLength(3)
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(outsideDir)).toBe(false)
  })

  it('still allows a dangling link that points inside the folder', async (ctx) => {
    const { readFileSync: read } = await import('node:fs')
    const root = tmp()
    link(ctx, join(root, 'real.txt'), join(root, 'alias.txt'))
    const ws = new Workspaces(ask(() => false))
    ws.setRoot('s1', root)
    await ws.writeTextFile('s1', 'alias.txt', 'ok')
    expect(read(join(root, 'real.txt'), 'utf8')).toBe('ok')
  })

  it('gives up on link loops instead of hanging', async (ctx) => {
    const root = tmp()
    link(ctx, join(root, 'b'), join(root, 'a'))
    link(ctx, join(root, 'a'), join(root, 'b'))
    const ws = new Workspaces(ask(() => false))
    ws.setRoot('s1', root)
    await expect(ws.writeTextFile('s1', 'a', 'x')).rejects.toThrow()
  })
})

describe('.. after a symlinked folder', () => {
  it('applies .. to the real folder, as the OS does, not to the spelling', async (ctx) => {
    const { mkdirSync, existsSync } = await import('node:fs')
    const base = tmp()
    const root = join(base, 'proj')
    const out = join(base, 'out')
    mkdirSync(root)
    mkdirSync(join(out, 'sub'), { recursive: true })
    link(ctx, join(out, 'sub'), join(root, 'outdir'), 'dir')
    // Spelled inside (proj/dotdot.txt), really out/dotdot.txt.
    link(ctx, 'outdir/../dotdot.txt', join(root, 'dotdot'))
    const asked: string[] = []
    const ws = new Workspaces(ask((d) => (asked.push(d), false)))
    ws.setRoot('s1', root)
    await expect(ws.writeTextFile('s1', 'dotdot', 'x')).rejects.toThrow()
    await expect(ws.writeTextFile('s1', 'outdir/../escape.txt', 'x')).rejects.toThrow()
    await expect(ws.createTerminal('s1', { command: 'ls', cwd: 'outdir/..' })).rejects.toThrow()
    expect(asked).toEqual([join(out, 'dotdot.txt'), join(out, 'escape.txt'), `${out}\nls`])
    expect(existsSync(join(out, 'dotdot.txt'))).toBe(false)
    // Plain .. that stays inside still works without asking, and new folders appear.
    await ws.writeTextFile('s1', 'a/b/../c.txt', 'ok')
    expect(existsSync(join(root, 'a', 'c.txt'))).toBe(true)
    expect(asked).toHaveLength(3)
  })
})

describe('a conversation with no folder yet', () => {
  it('runs commands in its scratch folder, and the user can make a folder it reaches for the working folder', async () => {
    const { mkdirSync } = await import('node:fs')
    const scratch = tmp()
    const desk = tmp()
    const project = join(desk, 'proj')
    mkdirSync(join(project, '.git'), { recursive: true })
    mkdirSync(join(project, 'src'))
    const offers: (string | undefined)[] = []
    const adopted: string[] = []
    let answer: AccessDecision = 'allow'
    const ws = new Workspaces({
      ask: async (_s, _t, _d, adopt) => (offers.push(adopt), answer),
      canWorkIn: () => true,
      adopted: (_s, folder) => adopted.push(folder)
    })
    ws.setRoot('s1', undefined, scratch)
    const id = await ws.createTerminal('s1', { command: 'node', args: ['-e', 'console.log(process.cwd())'] })
    await ws.waitForExit(id)
    expect(ws.output(id).output.trim()).toBe(scratch)
    expect(offers).toEqual([])
    // Once: allowed, and the folder stays the scratch one.
    await ws.writeTextFile('s1', join(desk, 'a.txt'), 'x')
    expect(offers).toEqual([desk])
    expect(ws.rootOf('s1')).toBe(scratch)
    // Adopting offers the project around the path (its .git), not the subfolder.
    answer = 'adopt'
    await ws.createTerminal('s1', { command: 'node', args: ['-e', '1'], cwd: join(project, 'src') })
    expect(offers[1]).toBe(project)
    expect(adopted).toEqual([project])
    expect(ws.rootOf('s1')).toBe(project)
    // Inside it now: no question; outside it: asked again, with no folder to adopt.
    await ws.writeTextFile('s1', join(project, 'b.txt'), 'y')
    expect(offers).toHaveLength(2)
    await ws.writeTextFile('s1', join(desk, 'c.txt'), 'z')
    expect(offers[2]).toBeUndefined()
  })

  it('offers no folder the app forbids, and asks nothing in a mode that trusts the agent', async () => {
    const scratch = tmp()
    const offers: (string | undefined)[] = []
    let trusted = false
    const ws = new Workspaces({ ask: async (_s, _t, _d, adopt) => (offers.push(adopt), 'allow'), canWorkIn: () => false, trusted: () => trusted })
    ws.setRoot('s1', undefined, scratch)
    await ws.writeTextFile('s1', join(tmp(), 'a.txt'), 'x')
    expect(offers).toEqual([undefined])
    trusted = true
    await ws.writeTextFile('s1', join(tmp(), 'b.txt'), 'x')
    expect(offers).toHaveLength(1)
  })
})
