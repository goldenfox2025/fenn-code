/** Small helpers shared by the platform input drivers. */
import { execFile } from 'node:child_process'

export function parseChord(chord: string): { mods: string[]; key: string } {
  const parts = chord
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
  // "ctrl++" means ctrl and the plus key.
  if (chord.trim().endsWith('++')) parts.splice(parts.length - 2, 2, '+')
  const alias: Record<string, string> = {
    control: 'ctrl',
    command: 'cmd',
    meta: 'cmd',
    super: 'cmd',
    win: 'cmd',
    windows: 'cmd',
    option: 'alt',
    opt: 'alt',
    return: 'enter',
    esc: 'escape',
    del: 'delete',
    pgup: 'pageup',
    pgdn: 'pagedown',
    page_up: 'pageup',
    page_down: 'pagedown',
    arrowup: 'up',
    arrowdown: 'down',
    arrowleft: 'left',
    arrowright: 'right',
    back_space: 'backspace',
    spacebar: 'space',
    plus: '+',
    minus: '-'
  }
  const norm = parts.filter((p) => p !== '').map((p) => alias[p] ?? p)
  const key = norm.pop() ?? ''
  return { mods: norm, key }
}

export const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'cmd', 'fn'])

export function run(cmd: string, args: string[], input?: string, timeout = 20_000, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20, env: env ?? process.env }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().slice(0, 400)))
      else resolve(stdout.toString())
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
