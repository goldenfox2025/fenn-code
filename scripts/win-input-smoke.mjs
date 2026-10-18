// Checks computer control's Windows input helper on a real Windows desktop.
// Usage (in the repository, on Windows): node scripts/win-input-smoke.mjs
//
// It opens its own small test window, then uses resources/win-input.ps1 to
// find that window, click into it, type (including Chinese) and press keys,
// and reads back what arrived. It moves the mouse and types only into that
// window, and closes it at the end.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('Windows only.')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'fenn-code-smoke-'))
const outFile = join(dir, 'text.txt')
const formScript = join(dir, 'form.ps1')
writeFileSync(
  formScript,
  '﻿' +
    `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class D { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[D]::SetProcessDPIAware() | Out-Null
$out = $args[0]
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Fenn Code 输入测试'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(200, 200)
$f.Size = New-Object System.Drawing.Size(600, 300)
$f.TopMost = $true
$t = New-Object System.Windows.Forms.TextBox
$t.Multiline = $true
$t.Dock = 'Fill'
$t.Font = New-Object System.Drawing.Font('Microsoft YaHei', 14)
$t.Add_TextChanged({ [IO.File]::WriteAllText($out, $t.Text, (New-Object System.Text.UTF8Encoding $false)) })
# A multi-line TextBox ignores Ctrl+A by itself: record the chord as it arrives, then select all.
$t.Add_KeyDown({ param($s, $e)
  if ($e.Control -and $e.KeyCode -eq 'A') {
    [IO.File]::AppendAllText($out + '.keys', "ctrl+a\n")
    $t.SelectAll()
    $e.SuppressKeyPress = $true
  }
})
$f.Controls.Add($t)
$f.Add_Shown({ $f.Activate() })
[System.Windows.Forms.Application]::Run($f)
`,
  'utf8'
)

const ps = (file, args = []) =>
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const form = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', formScript, outFile], { stdio: 'ignore' })
const started = Date.now()
const host = ps(join(root, 'resources', 'win-input.ps1'))
let stderr = ''
host.stderr.on('data', (d) => (stderr += d))
const waiters = new Map()
let buf = ''
let ready
const readyP = new Promise((r) => (ready = r))
host.stdout.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const m = JSON.parse(Buffer.from(line, 'base64').toString('utf8'))
    if (m.id === 0) ready()
    waiters.get(m.id)?.(m)
  }
})
let seq = 0
const call = (req) =>
  new Promise((resolve) => {
    const id = ++seq
    const timer = setTimeout(() => resolve({ ok: false, e: 'timeout' }), 20000)
    waiters.set(id, (m) => (clearTimeout(timer), resolve(m)))
    host.stdin.write(JSON.stringify({ ...req, id }) + '\n')
  })
const text = () => (existsSync(outFile) ? readFileSync(outFile, 'utf8') : '')

try {
  await Promise.race([readyP, sleep(30000)])
  check('helper starts', Date.now() - started < 30000, `${Date.now() - started} ms; ${stderr.trim().slice(0, 300)}`)
  await sleep(2500)
  const t0 = Date.now()
  const cur = await call({ op: 'cursor' })
  check('cursor', cur.ok, `${cur.r ?? cur.e} (${Date.now() - t0} ms)`)
  const at = await call({ op: 'at', x: 500, y: 350 })
  check('app under the test window', at.ok && String(at.r).split('\t')[0] === String(form.pid), String(at.r ?? at.e))
  const t1 = Date.now()
  const click = await call({ op: 'click', x: 500, y: 350, b: 'left', n: 1, mods: [] })
  check('click', click.ok, `${click.e ?? ''} (${Date.now() - t1} ms)`)
  await sleep(300)
  const front = await call({ op: 'front' })
  check('focused app is the test window', front.ok && String(front.r).split('\t')[0] === String(form.pid), String(front.r ?? front.e))
  await call({ op: 'type', s: b64('Hello Fenn Code 你好') })
  await sleep(500)
  check('type with Chinese', text() === 'Hello Fenn Code 你好', JSON.stringify(text()))
  await call({ op: 'key', keys: ['backspace'], n: 2, hold: 0 })
  await sleep(300)
  check('key with repeat', text() === 'Hello Fenn Code ', JSON.stringify(text()))
  await call({ op: 'key', keys: ['ctrl', 'a'], n: 1, hold: 0 })
  await call({ op: 'type', s: b64('x') })
  await sleep(300)
  const keys = existsSync(outFile + '.keys') ? readFileSync(outFile + '.keys', 'utf8') : ''
  check('chord ctrl+a arrives as one chord', keys.includes('ctrl+a'), JSON.stringify(keys.trim()))
  check('chord ctrl+a selects all', text() === 'x', JSON.stringify(text()))
  const apps = await call({ op: 'apps' })
  check('apps list', apps.ok && String(apps.r).includes(String(form.pid)), String(apps.r ?? apps.e).split('\n').length + ' apps')
} finally {
  host.kill()
  form.kill()
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
