import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'oc-appid-'))
const links = new Map<string, string>()
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => join(home, 'AppData'), setToastActivatorCLSID: () => undefined },
  shell: {
    readShortcutLink: (p: string) => ({ target: links.get(p) ?? '' }),
    writeShortcutLink: () => true
  }
}))
const { notificationsWouldTakeShortcut, winAppId, winCopy } = await import('../src/main/winAppId')

const lnk = join(home, 'AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Fenn Code.lnk')
const copyAt = (dir: string, installed: boolean) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'FennCode.exe'), '')
  if (installed) writeFileSync(join(dir, 'Uninstall Fenn Code.exe'), '')
  return join(dir, 'FennCode.exe')
}

describe('Windows app ids', () => {
  const installed = copyAt(join(home, 'Programs', 'fenn-code'), true)
  const portable = copyAt(join(home, 'Downloads', 'Fenn-Code-win'), false)

  it('tells the installed app, the portable zip and a run from source apart, each with its own id', () => {
    expect(winCopy('Fenn Code', true, installed)).toBe('installed')
    expect(winCopy('Fenn Code', true, portable)).toBe('portable')
    expect(winCopy('Fenn Code', false, portable)).toBe('source')
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
})
