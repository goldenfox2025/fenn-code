/**
 * Drives a real window with the Linux driver (xdotool). Runs only where an X
 * display and xdotool exist, e.g. `xvfb-run -a npx vitest run test/computer.linux.test.ts`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LinuxDriverImpl } from '../src/main/computer/linux'

function hasXdotool(): boolean {
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const canRun = process.platform === 'linux' && !!process.env.DISPLAY && hasXdotool()
function has(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
/** Real desktops have a window manager, which wraps each window in a frame of its own. */
/** Waits until the window has reported what was sent, or 3 s. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 30 && !done(); i++) await new Promise((r) => setTimeout(r, 100))
}
const WMS = process.env.WM_ONLY
  ? [process.env.WM_ONLY]
  : [undefined, ...(has('openbox') ? ['openbox', 'openbox without x11-utils'] : [])]

const WINDOW_MAIN = `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ x: 100, y: 100, width: 500, height: 300, frame: process.argv.includes('--framed'), show: true, webPreferences: { contextIsolation: false, nodeIntegration: true } })
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0"><textarea id=t style="width:100%;height:100%;font-size:20px"></textarea><script>const t=document.getElementById("t");t.addEventListener("input",()=>require("electron").ipcRenderer.send("v",t.value));document.addEventListener("keydown",e=>{if(e.ctrlKey&&e.key==="a")require("electron").ipcRenderer.send("ctrl-a")})</script></body>'))
  require('electron').ipcMain.on('v', (_e, v) => process.stdout.write(JSON.stringify({ v }) + '\\n'))
  require('electron').ipcMain.on('ctrl-a', () => process.stdout.write(JSON.stringify({ ctrlA: true }) + '\\n'))
  w.webContents.once('did-finish-load', () => process.stdout.write(JSON.stringify({ ready: true }) + '\\n'))
})
`

describe.skipIf(!canRun).each(WMS)('Linux driver on a real X display (window manager: %s)', (wm) => {
  let child: ChildProcess
  let wmProc: ChildProcess | undefined
  let savedPath: string | undefined
  let value = ''
  let ctrlA = false
  const driver = new LinuxDriverImpl({ toDevice: (x, y) => [x, y], fromDevice: (x, y) => [x, y] })

  beforeAll(async () => {
    if (wm) {
      wmProc = spawn('openbox', [], { stdio: 'ignore' })
      await new Promise((r) => setTimeout(r, 800))
    }
    if (wm?.includes('without')) {
      // Only xdotool on the PATH: the driver must find the app's window by itself.
      const bin = mkdtempSync(join(tmpdir(), 'xbin-'))
      symlinkSync(execFileSync('which', ['xdotool'], { encoding: 'utf8' }).trim(), join(bin, 'xdotool'))
      savedPath = process.env.PATH
      process.env.PATH = bin
    }
    const dir = mkdtempSync(join(tmpdir(), 'xwin-'))
    writeFileSync(join(dir, 'main.js'), WINDOW_MAIN)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as unknown as string
    child = spawn(electron, ['--no-sandbox', join(dir, 'main.js'), ...(wm ? ['--framed'] : [])], { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('window did not open')), 20_000)
      let buf = ''
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString()
        for (const line of buf.split('\n').slice(0, -1)) {
          try {
            const m = JSON.parse(line)
            if (m.ready) clearTimeout(timer), resolve()
            if (m.v !== undefined) value = m.v
            if (m.ctrlA) ctrlA = true
          } catch {
            /* other output */
          }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1)
      })
    })
    await new Promise((r) => setTimeout(r, 800))
  }, 30_000)

  afterAll(() => {
    child?.kill()
    wmProc?.kill()
    if (savedPath) process.env.PATH = savedPath
  })

  it('clicks, types (including Chinese), presses chords and finds the app under the pointer', async () => {
    expect(await driver.unavailable()).toBeUndefined()
    const at = await driver.appAt(300, 200)
    expect(at?.pid).toBe(child.pid)
    expect(await driver.appAt(900, 700)).toBeUndefined()
    await driver.click(300, 200, 'left', 1)
    // Focusing a window that is already open, by its app's name.
    expect((await driver.open('electron'))?.pid).toBe(child.pid)
    await driver.type('Hello Fenn Code 你好')
    await settle(() => value === 'Hello Fenn Code 你好')
    expect(value).toBe('Hello Fenn Code 你好')
    await driver.key('backspace', 2)
    await settle(() => value === 'Hello Fenn Code ')
    expect(value).toBe('Hello Fenn Code ')
    await driver.key('ctrl+a')
    await settle(() => ctrlA)
    expect(ctrlA).toBe(true)
    expect(await driver.cursor()).toEqual({ x: 300, y: 200 })
    const apps = await driver.apps()
    expect(apps.some((a) => a.pid === child.pid)).toBe(true)
  }, 30_000)
})
