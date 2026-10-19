import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'oc-appid-'))
let appData = join(home, 'AppData')
process.env.ProgramData = join(home, 'ProgramData')
const links = new Map<string, string>()
const written: { path: string; op: string; opts: Record<string, unknown> }[] = []
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => appData, getAppPath: () => join(home, 'checkout'), setToastActivatorCLSID: () => undefined },
  shell: {
    readShortcutLink: (p: string) => ({ target: links.get(p) ?? '' }),
    // As on Windows: 'replace' does nothing when there is no file yet, 'create' writes one either way.
    writeShortcutLink: (path: string, op: string, opts: Record<string, unknown>) => {
      if (op === 'replace' && !existsSync(path)) return false
      writeFileSync(path, '')
      written.push({ path, op, opts })
      return true
    }
  }
}))
const { notificationsWouldTakeShortcut, prepareSourceShortcut, winAppId, winCopy } = await import('../src/main/winAppId')

const programs = (root: string) => join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const lnk = join(programs(join(home, 'AppData')), 'Fenn Code.lnk')
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

  it('also keeps the zip from adding a second entry next to an all-users install', () => {
    const machine = join(programs(join(home, 'ProgramData')), 'Fenn Code.lnk')
    mkdirSync(join(machine, '..'), { recursive: true })
    writeFileSync(machine, '')
    links.set(machine, copyAt(join(home, 'Program Files', 'Fenn Code'), true))
    expect(notificationsWouldTakeShortcut('portable', 'Fenn Code', portable)).toBe(true)
    links.set(machine, portable)
    expect(notificationsWouldTakeShortcut('portable', 'Fenn Code', portable)).toBe(false)
  })

  it('writes the source run’s shortcut once there is a build, even where no Start Menu folder exists yet', () => {
    appData = mkdtempSync(join(tmpdir(), 'oc-appid-fresh-'))
    const electronLnk = join(programs(appData), 'Electron.lnk')
    // `npm run dev` alone builds nothing: the checkout would open blank, so Electron keeps its own shortcut.
    expect(prepareSourceShortcut('C:/fenn/resources/icon.ico')).toBe(false)
    expect(existsSync(programs(appData))).toBe(false)
    for (const f of ['main/index.js', 'renderer/index.html']) {
      mkdirSync(join(home, 'checkout', 'out', f, '..'), { recursive: true })
      writeFileSync(join(home, 'checkout', 'out', f), '')
    }
    expect(prepareSourceShortcut('C:/fenn/resources/icon.ico')).toBe(true)
    expect(existsSync(electronLnk)).toBe(true)
    const w = written.at(-1)!
    expect(w.path).toBe(electronLnk)
    expect(w.opts).toMatchObject({
      target: process.execPath,
      args: `"${join(home, 'checkout')}"`,
      appUserModelId: winAppId('source'),
      icon: 'C:/fenn/resources/icon.ico'
    })
    expect(w.opts.toastActivatorClsid).toMatch(/^\{[0-9A-F-]{36}\}$/)
  })
})
