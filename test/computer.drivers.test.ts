import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { until } from './helpers'
import { desktopExec } from '../src/main/computer/linux'
import { parseApp, WindowsDriverImpl } from '../src/main/computer/win'

/**
 * Stands in for resources/win-input.ps1: same protocol, records each request
 * and answers like the real helper would.
 */
const FAKE_HOST = String.raw`
const rl = require('readline').createInterface({ input: process.stdin })
const out = (o) => process.stdout.write(Buffer.from(JSON.stringify(o)).toString('base64') + '\n')
const text = (b) => Buffer.from(b || '', 'base64').toString('utf8')
out({ id: 0, ok: true, r: 'ready' })
rl.on('line', (line) => {
  const q = JSON.parse(line)
  process.stderr.write(JSON.stringify(q) + '\n')
  switch (q.op) {
    case 'cursor': return out({ id: q.id, ok: true, r: '300,150' })
    case 'front': return out({ id: q.id, ok: true, r: '42\tnotepad\t记事本' })
    case 'at': return out({ id: q.id, ok: true, r: q.x > 1000 ? null : '42\tnotepad\t记事本' })
    case 'apps': return out({ id: q.id, ok: true, r: '42\tnotepad\t记事本\n7\tWindowsTerminal\tTerminal\n' })
    case 'type': return out({ id: q.id, ok: true, r: text(q.s) })
    case 'open': return out({ id: q.id, ok: false, e: '找不到名为「' + text(q.s) + '」的程序。' })
    case 'crash': process.exit(3)
    case 'hang': return
    default: return out({ id: q.id, ok: true, r: null })
  }
})
`

function fakeDriver(timeoutMs = 30_000) {
  const log: Record<string, unknown>[] = []
  let starts = 0
  const driver = new WindowsDriverImpl(
    // A 150% display: logical points ×1.5 are physical pixels.
    { toDevice: (x, y) => [x * 1.5, y * 1.5], fromDevice: (x, y) => [x / 1.5, y / 1.5] },
    () => {
      starts++
      const child = spawn(process.execPath, ['-e', FAKE_HOST], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stderr.on('data', (d: Buffer) => {
        for (const l of d.toString().split('\n').filter(Boolean)) log.push(JSON.parse(l))
      })
      return child
    },
    timeoutMs
  )
  return { driver, log, starts: () => starts }
}

describe('Windows input helper protocol', () => {
  it('starts once, converts coordinates, and passes text safely', async () => {
    const { driver, log, starts } = fakeDriver()
    try {
      await driver.click(100, 200, 'right', 2, ['ctrl'])
      await driver.type('你好 "quotes" \n {braces}')
      await driver.key('ctrl+shift+t', 3)
      await driver.holdKey('shift', 500)
      expect(await driver.cursor()).toEqual({ x: 200, y: 100 })
      expect(await driver.frontmost()).toEqual({ id: 'notepad', name: '记事本', pid: 42 })
      expect(await driver.appAt(10, 10)).toEqual({ id: 'notepad', name: '记事本', pid: 42 })
      expect(await driver.appAt(5000, 10)).toBeUndefined()
      expect((await driver.apps()).map((a) => a.id)).toEqual(['notepad', 'windowsterminal'])
      await expect(driver.open('画图')).rejects.toThrow('找不到名为「画图」的程序')
      expect(starts()).toBe(1)
      await until(() => log.length >= 4)
      expect(log[0]).toMatchObject({ op: 'click', x: 150, y: 300, b: 'right', n: 2, mods: ['ctrl'] })
      expect(Buffer.from(String(log[1].s), 'base64').toString('utf8')).toBe('你好 "quotes" \n {braces}')
      expect(log[2]).toMatchObject({ op: 'key', keys: ['ctrl', 'shift', 't'], n: 3, hold: 0 })
      expect(log[3]).toMatchObject({ op: 'key', keys: ['shift'], n: 1, hold: 500 })
    } finally {
      driver.dispose()
    }
  })

  it('restarts the helper after it dies, and gives up on one that hangs', async () => {
    const { driver, starts } = fakeDriver(800)
    try {
      await expect((driver as unknown as { call(r: object): Promise<unknown> }).call({ op: 'crash' })).rejects.toThrow('意外退出')
      expect(await driver.unavailable()).toBeUndefined()
      expect(starts()).toBe(2)
      await expect((driver as unknown as { call(r: object): Promise<unknown> }).call({ op: 'hang' })).rejects.toThrow('没有响应')
      await driver.move(1, 1)
      expect(starts()).toBe(3)
    } finally {
      driver.dispose()
    }
  })

  it('reports a helper that cannot start', async () => {
    const driver = new WindowsDriverImpl(
      { toDevice: (x, y) => [x, y], fromDevice: (x, y) => [x, y] },
      () => spawn('/nonexistent/powershell.exe', [], { stdio: ['pipe', 'pipe', 'pipe'] })
    )
    expect(await driver.unavailable()).toContain('无法启动 PowerShell')
  })

  it('parses app lines', () => {
    expect(parseApp('12\tEXCEL\tMicrosoft Excel')).toEqual({ id: 'excel', name: 'Microsoft Excel', pid: 12 })
    expect(parseApp(null)).toBeUndefined()
    expect(parseApp('')).toBeUndefined()
  })

  it('ships a helper script Windows PowerShell can read', () => {
    const raw = readFileSync(join(__dirname, '../resources/win-input.ps1'))
    // UTF-8 with a BOM: without it Windows PowerShell misreads the Chinese messages.
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = raw.toString('utf8')
    for (const op of ['move', 'click', 'drag', 'scroll', 'type', 'key', 'cursor', 'front', 'at', 'apps', 'open'])
      expect(text).toContain(`'${op}' {`)
    // C# 5 (what Windows PowerShell compiles with) has no string interpolation or expression-bodied members.
    const cs = text.slice(text.indexOf("@'"), text.indexOf("'@"))
    expect(cs).not.toMatch(/\$"/)
    expect(cs).not.toMatch(/\)\s*=>\s*[^{]/)
  })
})

describe('Linux app launching', () => {
  it('finds an installed app by its name in .desktop files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apps-'))
    writeFileSync(join(dir, 'org.gnome.TextEditor.desktop'), '[Desktop Entry]\nName=Text Editor\nName[zh_CN]=文本编辑器\nExec=gnome-text-editor %U\n\n[Desktop Action new]\nName=New\nExec=gnome-text-editor --new\n')
    writeFileSync(join(dir, 'hidden.desktop'), '[Desktop Entry]\nName=Hidden Thing\nExec=hidden\nNoDisplay=true\n')
    expect(desktopExec('文本编辑器', [dir])).toBe('gnome-text-editor')
    expect(desktopExec('text editor', [dir])).toBe('gnome-text-editor')
    expect(desktopExec('editor', [dir])).toBe('gnome-text-editor')
    expect(desktopExec('hidden thing', [dir])).toBeUndefined()
  })
})
