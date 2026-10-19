import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Windows groups taskbar buttons and notifications by app id. For notifications to work at all,
 * Electron keeps a Start Menu shortcut carrying that id (EnsureShortcut in Electron's
 * windows_toast_activator.cc, run the first time a notification API is used). It names the
 * shortcut after the program file's product name and points it at the program that is running,
 * rewriting any shortcut of that name that points elsewhere.
 *
 * The installed app, the portable zip and a run from source must never share an id or rewrite one
 * another's shortcut, so each copy has an id of its own.
 */
export type WinCopy = 'installed' | 'portable' | 'source'

const APP_IDS: Record<WinCopy, string> = {
  installed: 'dev.fenncode.desktop',
  portable: 'dev.fenncode.desktop.portable',
  source: 'dev.fenncode.desktop.dev'
}

/** The installer puts its uninstaller next to the program; the zip has none. */
export function winCopy(productName: string, packaged = app.isPackaged, exe = process.execPath): WinCopy {
  if (!packaged) return 'source'
  return existsSync(join(dirname(exe), `Uninstall ${productName}.exe`)) ? 'installed' : 'portable'
}

export function winAppId(copy: WinCopy): string {
  return APP_IDS[copy]
}

function startMenuShortcut(name: string): string {
  return join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`)
}

/**
 * The portable zip has the installer's product name, so the shortcut Electron would keep for it is
 * the installed app's own 「<name>.lnk」: rewriting it would point the Start Menu at the zip. While an
 * installed copy owns that shortcut, the zip leaves notifications alone, which never creates it.
 */
export function notificationsWouldTakeShortcut(copy: WinCopy, productName: string, exe = process.execPath): boolean {
  if (copy !== 'portable') return false
  const lnk = startMenuShortcut(productName)
  if (!existsSync(lnk)) return false
  try {
    const target = shell.readShortcutLink(lnk).target
    return !!target && existsSync(target) && resolve(target).toLowerCase() !== resolve(exe).toLowerCase()
  } catch {
    return true
  }
}

/** A fixed activator for runs from source, so the shortcut written below stays valid from run to run. */
const SOURCE_TOAST_CLSID = '{5B0F7C1E-3A9D-4E62-9C1B-7F4D2E8A6C35}'

/**
 * A run from source is electron.exe, whose product name is 「Electron」: Electron keeps
 * 「Electron.lnk」 for it, with electron.exe's atom as the icon, and the taskbar shows that. Writing
 * the same shortcut first, as Electron would but with the fox icon, leaves Electron nothing to change.
 */
export function prepareSourceShortcut(icon: string): void {
  app.setToastActivatorCLSID(SOURCE_TOAST_CLSID)
  shell.writeShortcutLink(startMenuShortcut('Electron'), 'replace', {
    target: process.execPath,
    cwd: dirname(process.execPath),
    description: 'Electron',
    appUserModelId: APP_IDS.source,
    toastActivatorClsid: SOURCE_TOAST_CLSID,
    icon,
    iconIndex: 0
  })
}
