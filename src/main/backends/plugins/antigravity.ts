import { execFile, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, promises as fs, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CommandSpec } from '../../../shared/contract'
import { acpPlugin } from '../acp'
import { findOnPath } from '../install'
import { HarnessReaper, killWindowsTree, listWindowsProcesses } from '../harnessReaper'
import { readPyiArchive, topNames, unpackPyi, unpackedEntries } from '../pyiArchive'
import { stopAgentProcess, whenExited } from '../workspace'
import { t, tk } from '../../../shared/i18n'

/**
 * Google Antigravity's own ACP server (the ACP registry's `antigravity-acp`). The `agy`
 * command line has no ACP mode; Google ships this server for editors instead. It signs in
 * on its own (Google account or a Gemini API key) and keeps its state in ~/.gemini/antigravity-acp.
 */
const VERSION = '1.4.0'
const EXE = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
/** Where the app's 「安装」 puts it. */
export const AGY_HOME = join(homedir(), '.agy-acp-server')
/** The Google sign-in the server keeps after 「登录」. */
const AGY_TOKEN = join(homedir(), '.gemini', 'antigravity-acp', 'acp_token.json')

const ARCHIVES: Record<string, string> = {
  'win32-x64': `windows/agy-acp-server-${VERSION}-windows-x86_64.zip`,
  'win32-arm64': `windows/agy-acp-server-${VERSION}-windows-arm64.zip`,
  'darwin-arm64': `macos/agy-acp-server-${VERSION}-darwin-arm64.zip`,
  'darwin-x64': `macos/agy-acp-server-${VERSION}-darwin-x86_64.zip`,
  'linux-x64': `linux/agy-acp-server-${VERSION}-linux-x86_64.zip`,
  'linux-arm64': `linux/agy-acp-server-${VERSION}-linux-arm64.zip`
}
const archive = ARCHIVES[`${process.platform}-${process.arch}`]

/** The server: the path set in settings, AGY_ACP_BIN, the app's own install, or one on PATH. */
export function findAgy(config: Record<string, string> = {}, env = process.env): string | undefined {
  for (const p of [config.AGY_ACP_BIN, env.AGY_ACP_BIN, join(AGY_HOME, EXE)]) if (p && existsSync(p)) return p
  return findOnPath(EXE, env) ?? findOnPath('agy_acp_server', env)
}

/*
 * On Windows the server is a PyInstaller "onefile" program: each start unpacks some 330 MB of its
 * own files into the temp folder, and deletes them only when it exits on its own. So 「安装」 unpacks
 * them once into AGY_UNPACKED, and the server runs from there (the way its own bootloader hands that
 * folder to the program it starts): no unpacking, nothing left in the temp folder.
 */

/**
 * The folder 「安装」 unpacks into. Its name has the form the bootloader gives its temp folder
 * (_MEI, eight hex digits, six more characters), which the program checks before running from it.
 */
export const AGY_UNPACKED = join(AGY_HOME, `_MEI00000000agy${VERSION.replace(/\D/g, '').slice(0, 3).padEnd(3, '0')}`)

interface Stamp {
  exe: string
  size: number
  mtimeMs: number
  /** That executable can't be unpacked ahead (it keeps unpacking itself). */
  unsupported?: boolean
}

/** What 「安装」 recorded about the unpacked folder, when it was made from this very executable (same path, size and time). */
function stampFor(exe: string, home: string): Stamp | undefined {
  try {
    const st = statSync(exe)
    const s = JSON.parse(readFileSync(`${home}.json`, 'utf8')) as Stamp
    return s.exe === resolve(exe) && s.size === st.size && s.mtimeMs === st.mtimeMs ? s : undefined
  } catch {
    return undefined
  }
}

/** The unpacked folder, when it was made from this executable and is there; otherwise the server unpacks itself. */
export function unpackedFor(exe: string | undefined, home = AGY_UNPACKED): string | undefined {
  if (!exe) return undefined
  const s = stampFor(exe, home)
  return s && !s.unsupported && existsSync(home) ? home : undefined
}

/** Installed on Windows, but its files haven't been unpacked ahead for this copy yet. */
export function needsUnpack(exe: string | undefined, platform = process.platform, home = AGY_UNPACKED): boolean {
  return platform === 'win32' && !!exe && !stampFor(exe, home)
}

/** 「安装」's last step: unpacks the server's files once (see AGY_UNPACKED). */
export async function unpackServer(exe: string, onLine: (line: string) => void, home = AGY_UNPACKED): Promise<void> {
  const st = statSync(exe)
  const stamp = (extra: Partial<Stamp> = {}) => writeFileSync(`${home}.json`, JSON.stringify({ exe: resolve(exe), size: st.size, mtimeMs: st.mtimeMs, ...extra }))
  rmSync(`${home}.json`, { force: true })
  const a = await readPyiArchive(exe)
  if (!a || !unpackedEntries(a)) {
    stamp({ unsupported: true })
    onLine(t('这个版本的服务不能预先解出，每次启动仍会解压到临时文件夹。'))
    return
  }
  const part = `${home}.part`
  await fs.rm(part, { recursive: true, force: true })
  let shown = 0
  const r = await unpackPyi(exe, a, part, (done, total) => {
    const tenth = Math.floor((done * 10) / total)
    if (tenth > shown) onLine(`${(shown = tenth) * 10}%`)
  })
  await swapIn(part, home)
  stamp()
  onLine(t('已解出 {0} 个文件（{1} MB），以后启动不再解压到临时文件夹。', r.files, Math.round(r.bytes / 1048576)))
}

/**
 * Puts the folder `next` where `home` is. The old folder is only moved aside until the new one is
 * in, and goes back when the new one can't be moved in, so there is always a working server. It is
 * removed last; when Windows keeps holding its files it is left there (a later 「安装」 tries again).
 */
export async function swapIn(
  next: string,
  home: string,
  ops: { exists: (p: string) => boolean; rename: (from: string, to: string) => Promise<void>; remove: (p: string) => Promise<boolean> } = {
    exists: existsSync,
    rename: (from, to) => renameRetrying(from, to),
    remove: (p) => removeRetrying(p)
  }
): Promise<void> {
  if (!ops.exists(home)) return ops.rename(next, home)
  let old = `${home}.old`
  // One left by an earlier 「安装」 that still can't go: move this one aside under another name.
  if (!(await ops.remove(old))) old += `-${Date.now()}`
  await ops.rename(home, old)
  try {
    await ops.rename(next, home)
  } catch (e) {
    await ops.rename(old, home).catch(() => undefined)
    throw e
  }
  await ops.remove(old)
}

/** Removes a folder, trying again briefly when Windows holds its files; false when it is still there. */
export async function removeRetrying(
  path: string,
  rm: (path: string) => Promise<void> = (p) => fs.rm(p, { recursive: true, force: true }),
  waits: number[] = [100, 300, 700, 1500]
): Promise<boolean> {
  for (let i = 0; ; i++) {
    try {
      await rm(path)
      return true
    } catch {
      if (i >= waits.length) return false
      await new Promise((r) => setTimeout(r, waits[i]))
    }
  }
}

/**
 * Renames, trying again briefly when Windows says the folder is busy: a virus scanner or the
 * indexer often holds files just written for a moment. Any other error is thrown at once.
 */
export async function renameRetrying(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = fs.rename,
  waits: number[] = [100, 300, 700, 1500, 3000]
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= waits.length || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await new Promise((r) => setTimeout(r, waits[i]))
    }
  }
}

/**
 * The install step that unpacks the downloaded zip. tar reads a zip on Windows 10+ and macOS
 * (both bsdtar); GNU tar on Linux doesn't, so there unzip, or Python's zipfile when that is all
 * there is (it drops the execute bit, which launch sets again).
 */
export function unzipStep(
  zip: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CommandSpec & { label: string; labelArgs?: unknown[] } {
  const label = tk('解压 Antigravity 服务')
  if (platform !== 'linux') return { label, command: 'tar', args: ['-xf', zip, '-C', dir] }
  if (!findOnPath('unzip', env) && findOnPath('python3', env)) return { label, command: 'python3', args: ['-I', '-m', 'zipfile', '-e', zip, dir] }
  return {
    label: findOnPath('unzip', env) ? label : tk('解压 Antigravity 服务（需要 unzip，但没有找到：请先安装它，例如 sudo apt install unzip，然后重试）'),
    command: 'unzip',
    args: ['-o', zip, '-d', dir]
  }
}

/** The environment that makes the server run from its unpacked folder (native paths; with others it unpacks again). */
export function unpackedEnv(exe: string, home: string): Record<string, string> {
  return { _PYI_ARCHIVE_FILE: resolve(exe), _PYI_APPLICATION_HOME_DIR: resolve(home), _PYI_PARENT_PROCESS_LEVEL: '1' }
}

const run = (script: string, timeout: number) =>
  new Promise<string>((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout }, (_err, out) => done(String(out ?? '')))
  })
const quote = (s: string) => s.replace(/'/g, "''")

/** Executables already checked for leftovers since the app started. */
const reaped = new Set<string>()

/**
 * Ends servers a crash or a forced quit left running (their parent is gone). The server doesn't
 * exit when its input closes, so these stay, and keep its files locked against a reinstall.
 * Only copies of this very program whose parent has exited; one another app runs is left alone.
 * A bootloader left behind has only the server it started ended, so it deletes its temp folder itself.
 */
export function reapOrphans(exe: string | undefined): Promise<void> {
  if (process.platform !== 'win32' || !exe) return Promise.resolve()
  const script = [
    `$all = @(Get-CimInstance Win32_Process -Filter "Name='${EXE}'" | Where-Object { $_.ExecutablePath -ieq '${quote(exe)}' })`,
    `$orphans = @($all | Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) })`,
    `$waiting = @()`,
    `foreach ($o in $orphans) { $kids = @($all | Where-Object { $_.ParentProcessId -eq $o.ProcessId }); if ($kids.Count) { foreach ($k in $kids) { taskkill /PID $k.ProcessId /T /F | Out-Null }; $waiting += $o } else { taskkill /PID $o.ProcessId /T /F | Out-Null } }`,
    `$until = (Get-Date).AddSeconds(12)`,
    `while ($waiting.Count -and (Get-Date) -lt $until -and @($waiting | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count) { Start-Sleep -Milliseconds 300 }`,
    `foreach ($o in $waiting) { if (Get-Process -Id $o.ProcessId -ErrorAction SilentlyContinue) { taskkill /PID $o.ProcessId /T /F | Out-Null } }`
  ].join('; ')
  return run(script, 25_000).then(() => undefined)
}

/** How long a temp folder must have sat unchanged before it may be one a crash left (not one being unpacked now). */
const STALE_MS = 5 * 60_000

/** Temp folders this cleanup renamed but couldn't finish deleting (a file still held): the only renamed ones it takes up again. */
const STALE_LIST = join(AGY_HOME, 'stale-temp.json')

/**
 * Deletes temp folders earlier runs of the server left (a forced stop keeps it from deleting its own).
 * One is the server's only when everything in it is a name the server unpacks, and at least half of
 * them are there; one in use (Windows won't rename a folder whose files a running program holds) is
 * left. Other programs' PyInstaller folders don't match and are never touched. Returns how many went.
 */
export async function cleanStaleTemp(exe: string, tmp = tmpdir(), now = Date.now(), list = STALE_LIST): Promise<number> {
  const a = await readPyiArchive(exe).catch(() => undefined)
  const names = a ? topNames(a) : new Set<string>()
  if (names.size < 3) return 0
  const unfinished = new Set<string>(await fs.readFile(list, 'utf8').then((s) => JSON.parse(s) as string[], () => []))
  const left: string[] = []
  let removed = 0
  for (const d of await fs.readdir(tmp, { withFileTypes: true }).catch(() => [])) {
    const m = /^_MEI[0-9A-Za-z]+(-fenn-stale)?$/.exec(d.name)
    if (!m || !d.isDirectory() || (m[1] && !unfinished.has(d.name))) continue
    const dir = join(tmp, d.name)
    let gone = dir
    try {
      const st = await fs.lstat(dir)
      // One this cleanup renamed is known to be a leftover; any other must have sat a while.
      if (!st.isDirectory() || (!m[1] && now - st.mtimeMs < STALE_MS)) continue
      const entries = (await fs.readdir(dir)).map((e) => e.toLowerCase())
      if (!entries.every((e) => names.has(e))) continue
      // One this cleanup renamed but couldn't finish deleting: what's left of it may be any part.
      if (!m[1] && entries.length < Math.max(3, Math.ceil(names.size / 2))) continue
      if (!m[1]) {
        gone = `${dir}-fenn-stale`
        await fs.rename(dir, gone)
      }
      await fs.rm(gone, { recursive: true, force: true })
      removed++
    } catch {
      // In use, or partly deleted: left for next time.
      if (gone !== dir || m[1]) left.push(`${d.name}${m[1] ? '' : '-fenn-stale'}`)
    }
  }
  if (left.length || unfinished.size) await fs.writeFile(list, JSON.stringify(left)).catch(() => undefined)
  return removed
}

/** Servers started from their unpacked folder: they are the program itself, with nothing to clean up after. */
const direct = new WeakSet<ChildProcess>()
/** For each server that unpacked itself: the process it started (the program; the first is only its bootloader). */
const programs = new WeakMap<ChildProcess, Promise<number | undefined>>()
/** The last start ran from the unpacked folder and hasn't answered yet: if it never does, the next start unpacks as before. */
let unpackedPending = false
let unpackedFailed = false

/** Finds the program a bootloader started, in the background (PowerShell takes a second or two). */
function findProgram(proc: ChildProcess): Promise<number | undefined> {
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${proc.pid}" | Where-Object { $_.Name -ieq '${EXE}' } | Select-Object -First 1 -ExpandProperty ProcessId`
  return run(script, 15_000).then((out) => Number(out.trim()) || undefined)
}

/**
 * Stops a server. One that unpacked itself to the temp folder has only its program ended, so the
 * bootloader deletes that folder before it exits (forced after a while). Resolves once it has exited.
 */
function stopServer(proc: ChildProcess): Promise<void> {
  const program = programs.get(proc)
  if (process.platform !== 'win32' || direct.has(proc) || !program || proc.exitCode !== null) return stopAgentProcess(proc)
  const done = whenExited(proc, 8000)
  void Promise.race([program, new Promise<undefined>((r) => setTimeout(r, 2000))]).then((pid) => {
    if (!pid) return void stopAgentProcess(proc)
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  })
  return done.then(() => (proc.exitCode === null && proc.signalCode === null ? stopAgentProcess(proc) : undefined))
}

/** Each app start: ends leftovers, then deletes the temp folders earlier runs left; never in a start's way. */
function tidy(exe: string): void {
  if (reaped.has(exe)) return
  reaped.add(exe)
  void reapOrphans(exe)
    .then(() => (process.platform === 'win32' ? cleanStaleTemp(exe) : 0))
    .catch(() => undefined)
}

/** Ends the localharness program each closed session leaves behind (Windows, where the leak was seen). */
const harnesses = process.platform === 'win32' ? new HarnessReaper(listWindowsProcesses, killWindowsTree) : undefined

const MISSING = tk('找不到 Antigravity 的 ACP 服务（agy_acp_server）。请在 设置 → Agent 后端 → Antigravity 里点「安装」，或填写它的路径，然后重试。')

export default acpPlugin({
  id: 'antigravity',
  name: 'Antigravity',
  description: tk('Google Antigravity（agy）官方 ACP 服务'),
  signIn: true,
  sessionLog: 'antigravity',
  settings: [
    {
      key: 'GEMINI_API_KEY',
      label: 'Gemini API Key',
      secret: true,
      placeholder: 'AI…',
      help: tk('填了就用这个 Key，按 Gemini API 计费，不用 Antigravity 套餐的额度（在 aistudio.google.com 生成）。留空则点上方「登录」，用 Google 账号登录。')
    },
    { key: 'AGY_ACP_BIN', label: tk('服务程序路径'), placeholder: EXE, help: tk('留空自动查找；也可填写 agy_acp_server 的绝对路径。') }
  ],
  isInstalled: (config) => !!findAgy(config),
  // Signed in when it has a key, or the Google sign-in it stores after 「登录」.
  accountState: (config) => {
    if (!findAgy(config)) return { installed: false }
    const exe = findAgy(config)
    const setup = { setupPending: needsUnpack(exe) || undefined, setupDone: (process.platform === 'win32' && !!unpackedFor(exe)) || undefined }
    if (config.GEMINI_API_KEY || process.env.GEMINI_API_KEY) return { installed: true, signedIn: true, detail: 'Gemini API Key', ...setup }
    return existsSync(AGY_TOKEN) ? { installed: true, signedIn: true, detail: tk('Google 账号'), ...setup } : { installed: true, signedIn: false, ...setup }
  },
  quirks: {
    missingHint: MISSING,
    // A new process signs in again (an OAuth refresh of several seconds) on its first session: warming up does that early.
    warmSession: true,
    modelAtStart: true,
    // Every session/new still creates its conversation on Google's side (some 2 s).
    spareSession: true,
    started: (proc) => {
      if (unpackedPending) {
        unpackedPending = false
        direct.add(proc)
      } else if (process.platform === 'win32') programs.set(proc, findProgram(proc))
    },
    stop: stopServer,
    // Each open session keeps a localharness program running; idle chats beyond these are closed and reopened when used.
    openSessionLimit: 4,
    sessionTracker: harnesses && {
      begin: () => harnesses.begin(),
      closed: (sessionId, proc) => void harnesses.release(sessionId, proc?.pid).catch(() => undefined),
      exited: () => harnesses.reset()
    },
    // It advertises `_meta.antigravity.systemPrompt.append` in its capabilities; rules there outlive its compaction.
    systemPromptMeta: 'antigravity.systemPrompt.append',
    // Each new server process asks for sign-in again: with a key, or the Google sign-in it stored.
    autoAuth: (config) => (config.GEMINI_API_KEY ? 'gemini-api-key' : existsSync(AGY_TOKEN) ? 'oauth-personal' : undefined)
  },
  // Built-in curl and tar (Windows 10 and later have both; on Linux unzip, see unzipStep): download Google's archive, unpack it into ~/.agy-acp-server.
  // The version is the one this release was tested with, so it is offered to install, not as an update.
  upgrade: archive
    ? {
        installOnly: true,
        before: () => reapOrphans(join(AGY_HOME, EXE)),
        ...(process.platform === 'win32'
          ? {
              setup: {
                label: tk('在 {0} 预先解出服务的程序文件（约 330 MB），以后每次启动不再解压到临时文件夹'),
                labelArgs: [AGY_UNPACKED],
                run: async (onLine: (line: string) => void) => {
                  const exe = findAgy()
                  if (exe) await unpackServer(exe, onLine)
                }
              }
            }
          : {}),
        run: { command: 'curl', args: ['-fsSL', '--retry', '2', '--connect-timeout', '30', '--create-dirs', '-o', join(AGY_HOME, 'agy-acp-server.zip'), `https://dl.google.com/agy-extensions/releases/${archive}`] },
        after: unzipStep(join(AGY_HOME, 'agy-acp-server.zip'), AGY_HOME)
      }
    : undefined,
  launch: async ({ config, defaultModel }) => {
    const exe = findAgy(config)
    // Unzipped by the app's install on macOS or Linux, the server may lack its execute bit.
    if (exe && process.platform !== 'win32' && exe.startsWith(AGY_HOME))
      try {
        if (!(statSync(exe).mode & 0o100)) chmodSync(exe, 0o755)
      } catch {
        // Left as it is; starting it says what is wrong.
      }
    // Leftovers can only come from an earlier run of the app, so one look per app start is enough; it runs alongside.
    if (exe) tidy(exe)
    // The last start from the unpacked folder never answered (e.g. refused when run as administrator): unpack as before.
    if (unpackedPending) unpackedFailed = true
    const home = process.platform === 'win32' && !unpackedFailed ? unpackedFor(exe) : undefined
    unpackedPending = !!home
    return {
      command: exe ?? EXE,
      // The registry's Linux entry passes an empty --uid.
      args: process.platform === 'linux' ? ['--uid='] : [],
      env: {
        ...(exe && home ? unpackedEnv(exe, home) : {}),
        GEMINI_API_KEY: config.GEMINI_API_KEY || undefined,
        // A new session always opens on the server's default model, and a switch restarts its harness
        // (seconds): start it on the one chosen for new chats (see quirks.modelAtStart).
        AGY_ACP_DEFAULT_MODEL: config.model || defaultModel?.() || undefined
      }
    }
  }
})
