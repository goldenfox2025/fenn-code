import { app, shell } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

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

/**
 * The installer puts its uninstaller next to the program, named after the program file
 * (「Uninstall FennCode.exe」, for a per-user or a per-machine install alike); the zip has none.
 */
export function winCopy(packaged = app.isPackaged, exe = process.execPath): WinCopy {
  if (!packaged) return 'source'
  return existsSync(join(dirname(exe), `Uninstall ${basename(exe, extname(exe))}.exe`)) ? 'installed' : 'portable'
}

export function winAppId(copy: WinCopy): string {
  return APP_IDS[copy]
}

const programs = (root: string) => join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs')

/** The per-user Start Menu, where Electron keeps its shortcut. */
function startMenuShortcut(name: string): string {
  return join(programs(app.getPath('appData')), `${name}.lnk`)
}

/** Where an installed copy's shortcut can be: the per-user Start Menu, or the all-users one for 「为所有用户安装」. */
function installedShortcuts(name: string): string[] {
  return [startMenuShortcut(name), join(programs(process.env.ProgramData || 'C:\\ProgramData'), `${name}.lnk`)]
}

/**
 * The portable zip has the installer's product name, so the shortcut Electron would keep for it is
 * the installed app's own 「<name>.lnk」: rewriting it would point the Start Menu at the zip, and next
 * to an all-users install it would add a second entry of the same name. While an installed copy owns
 * either shortcut, the zip leaves notifications alone, which never creates one.
 */
export function notificationsWouldTakeShortcut(copy: WinCopy, productName: string, exe = process.execPath): boolean {
  if (copy !== 'portable') return false
  return installedShortcuts(productName).some((lnk) => {
    if (!existsSync(lnk)) return false
    try {
      const target = shell.readShortcutLink(lnk).target
      return !!target && existsSync(target) && resolve(target).toLowerCase() !== resolve(exe).toLowerCase()
    } catch {
      return true
    }
  })
}

/** A fixed activator for runs from source, so the shortcut written below stays valid from run to run. */
const SOURCE_TOAST_CLSID = '{5B0F7C1E-3A9D-4E62-9C1B-7F4D2E8A6C35}'

/**
 * A run from source is electron.exe, whose product name is 「Electron」: Electron keeps
 * 「Electron.lnk」 for it, with electron.exe's atom as the icon and no arguments, so the Start Menu
 * entry opens Electron's own default app. Writing the same shortcut first, with the fields Electron
 * checks (program, folder, app id, activator; ExistingShortcutValid compares no arguments or icon),
 * plus the fox icon and this checkout as the argument, leaves Electron nothing to change and makes
 * the entry open Fenn Code from source. It runs before anything can use notifications (the top of
 * app ready), since that is when Electron checks the shortcut.
 *
 * The entry opens the last build, so it is written only once there is one: `npm run dev` alone
 * serves the pages from its dev server and builds none, and the checkout would open a blank window
 * or Electron's 「Unable to find app」. Until then Electron keeps its own shortcut, as for any app.
 */
export function prepareSourceShortcut(icon: string): boolean {
  const checkout = app.getAppPath()
  if (!['main/index.js', 'renderer/index.html'].every((f) => existsSync(join(checkout, 'out', f)))) return false
  app.setToastActivatorCLSID(SOURCE_TOAST_CLSID)
  const lnk = startMenuShortcut('Electron')
  mkdirSync(dirname(lnk), { recursive: true })
  // 'create' writes it whether or not it exists ('replace' does nothing on a fresh machine).
  shell.writeShortcutLink(lnk, 'create', {
    target: process.execPath,
    args: `"${checkout}"`,
    cwd: dirname(process.execPath),
    description: 'Fenn Code (source)',
    appUserModelId: APP_IDS.source,
    toastActivatorClsid: SOURCE_TOAST_CLSID,
    icon,
    iconIndex: 0
  })
  return true
}
