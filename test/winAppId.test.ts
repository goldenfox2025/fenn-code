import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'oc-appid-'))
const links = new Map<string, string>()
const written: { path: string; op: string; opts: Record<string, unknown> }[] = []
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => join(home, 'AppData'), getAppPath: () => join(home, 'checkout'), setToastActivatorCLSID: () => undefined },
  shell: {
    readShortcutLink: (p: string) => ({ target: links.get(p) ?? '' }),
    writeShortcutLink: (path: string, op: string, opts: Record<string, unknown>) => (written.push({ path, op, opts }), true)
  }
}))
const { notificationsWouldTakeShortcut, prepareSourceShortcut, winAppId, winCopy } = await import('../src/main/winAppId')

const lnk = join(home, 'AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Fenn Code.lnk')
const copyAt = (dir: string, installed: boolean) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'FennCode.exe'), '')
  // electron-builder's NSIS names it after the program file (executableName), not the product name.
  if (installed) writeFileSync(join(dir, 'Uninstall FennCode.exe'), '')
  return join(dir, 'FennCode.exe')
}

describe('Windows app ids', () => {
  const installed = copyAt(join(home, 'Programs', 'fenn-code'), true)
  const portable = copyAt(join(home, 'Downloads', 'Fenn-Code-win'), false)

  it('tells the installed app, the portable zip and a run from source apart, each with its own id', () => {
    expect(winCopy(true, installed)).toBe('installed')
    expect(winCopy(true, portable)).toBe('portable')
    expect(winCopy(false, portable)).toBe('source')
    // A per-machine install is the same layout under Program Files.
    expect(winCopy(true, copyAt(join(home, 'Program Files', 'FennCode'), true))).toBe('installed')
    // An uninstaller named after the product, which electron-builder never writes, is not taken for one.
    const misnamed = copyAt(join(home, 'Elsewhere'), false)
    writeFileSync(join(home, 'Elsewhere', 'Uninstall Fenn Code.exe'), '')
    expect(winCopy(true, misnamed)).toBe('portable')
    expect(winAppId('installed')).toBe('dev.fenncode.desktop')
    expect(new Set(['installed', 'portable', 'source'].map((c) => winAppId(c as never))).size).toBe(3)
  })

  it('keeps the portable zip off the installed app’s Start Menu shortcut', () => {
    // No shortcut yet: the zip may make its own.
    expect(notificationsWouldTakeShortcut('portable', 'Fenn Code', portable)).toBe(false)
    mkdirSync(join(lnk, '..'), { recursive: true })
    writeFileSync(lnk, '')
    links.set(lnk, installed)
    expect(notificationsWouldTakeShortcut('portable', 'Fenn Code', portable)).toBe(true)
    // The installed app itself, and a shortcut that is already the zip's or points at nothing, are left as they are.
    expect(notificationsWouldTakeShortcut('installed', 'Fenn Code', installed)).toBe(false)
    links.set(lnk, portable)
    expect(notificationsWouldTakeShortcut('portable', 'Fenn Code', portable)).toBe(false)
    links.set(lnk, join(home, 'gone', 'FennCode.exe'))
    expect(notificationsWouldTakeShortcut('portable', 'Fenn Code', portable)).toBe(false)
  })

  it('writes the source run’s shortcut even where none exists yet, opening this checkout with the fox icon', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'oc-appid-fresh-'))
    const before = home
    void before
    prepareSourceShortcut('C:/fenn/resources/icon.ico')
    const w = written.at(-1)!
    // 'replace' would fail on a missing file and leave Electron to write its own.
    expect(w.op).toBe('create')
    expect(w.path.endsWith(join('Start Menu', 'Programs', 'Electron.lnk'))).toBe(true)
    expect(w.opts).toMatchObject({
      target: process.execPath,
      args: `"${join(home, 'checkout')}"`,
      appUserModelId: winAppId('source'),
      icon: 'C:/fenn/resources/icon.ico'
    })
    expect(w.opts.toastActivatorClsid).toMatch(/^\{[0-9A-F-]{36}\}$/)
    void fresh
  })
})
