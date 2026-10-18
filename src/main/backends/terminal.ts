/**
 * Opens a visible terminal window running one command, for agents that sign
 * in interactively (e.g. `qodercli login`). The window stays open afterwards
 * so the user can read what happened.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { t } from '../../shared/i18n'

export interface TerminalLaunch {
  command: string
  args: string[]
  /** Pass to spawn with { detached: true, stdio: 'ignore' }. */
  windowsVerbatimArguments?: boolean
}

const winQuote = (a: string) => (/^[\w./:\\=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)
const shQuote = (a: string) => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, name)))
}

/** How to open a terminal running `command args` on this platform, or null if no terminal was found. */
export function terminalLaunch(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): TerminalLaunch | null {
  if (platform === 'win32') {
    const line = [command, ...args].map(winQuote).join(' ')
    // `start` opens a new console window; the empty title keeps it from eating the first quoted argument.
    // /s /k "<line>": cmd drops just the outer quotes, so every quoted argument inside survives.
    return { command: 'cmd.exe', args: ['/d', '/c', `start "" cmd.exe /s /k "${line}"`], windowsVerbatimArguments: true }
  }
  const line = [command, ...args].map(shQuote).join(' ')
  if (platform === 'darwin') {
    const script = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return {
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate']
    }
  }
  const hold = `${line}; echo; echo '${t('完成后可以关闭这个窗口。').replace(/'/g, '')}'; read -r _`
  const candidates: [string, string[]][] = [
    ['x-terminal-emulator', ['-e', 'sh', '-c', hold]],
    ['gnome-terminal', ['--', 'sh', '-c', hold]],
    ['konsole', ['-e', 'sh', '-c', hold]],
    ['xfce4-terminal', ['-x', 'sh', '-c', hold]],
    ['kitty', ['sh', '-c', hold]],
    ['alacritty', ['-e', 'sh', '-c', hold]],
    ['xterm', ['-e', 'sh', '-c', hold]]
  ]
  for (const [bin, a] of candidates) if (onPath(bin, env)) return { command: bin, args: a }
  return null
}

/** Opens the terminal; rejects with a Chinese message if none could be started. */
export function openTerminal(command: string, args: string[]): Promise<void> {
  const l = terminalLaunch(command, args)
  if (!l) return Promise.reject(new Error(t('没有找到可用的终端。请自己打开一个终端，运行：{0}', [command, ...args].join(' '))))
  return new Promise((resolve, reject) => {
    // The one window the app opens on purpose: the terminal the user signs in with. On Windows the outer
    // cmd.exe is detached (no console of its own) and `start` opens the visible one, so nothing flashes.
    const p = spawn(l.command, l.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: l.windowsVerbatimArguments, windowsHide: false })
    p.once('error', (e) => reject(new Error(t('无法打开终端：{0}。请自己打开一个终端，运行：{1}', e.message, [command, ...args].join(' ')))))
    p.once('spawn', () => {
      p.unref()
      resolve()
    })
  })
}
