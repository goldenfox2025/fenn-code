/**
 * Running a backend's own upgrade command (e.g. `npm install -g some-cli@latest`)
 * and asking what the latest version is. Output streams back line by line.
 */
import { execFile, spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import type { CommandSpec } from '../../shared/contract'
import { windowsSafe } from './acp/AcpBackend'
import { findOnPath } from './install'
import { endTree, outputDecoder } from './workspace'
import { t } from '../../shared/i18n'

/** The user's environment; with a proxy set, Node's own downloads use it too. */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) out.NODE_USE_ENV_PROXY ??= '1'
  return out
}

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/

/** The latest version the command prints, or undefined if it can't tell. */
export function latestVersion(spec: CommandSpec, timeoutMs = 30_000): Promise<string | undefined> {
  const { command, args, shell } = windowsSafe(spec.command, spec.args ?? [])
  return new Promise((resolve) => {
    const child = execFile(command, args, { env: commandEnv(), shell, windowsHide: true }, (err, stdout) => {
      clearTimeout(timer)
      resolve(err ? undefined : String(stdout).match(VERSION)?.[0])
    })
    // Not execFile's own timeout: on Windows that ends only cmd.exe, and the command it runs keeps going.
    const timer = setTimeout(() => endTree(child), timeoutMs)
  })
}

/** Runs the command, passing each output line on; resolves with whether it succeeded. */
export function runStreaming(spec: CommandSpec, onLine: (line: string) => void, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; output: string }> {
  // A new Mac (or PC) has no Node.js: say what to install instead of a bare "spawn npm ENOENT".
  if (/^(npm|npx|node)$/i.test(spec.command) && !findOnPath(spec.command, commandEnv())) {
    const line = t('没有找到 Node.js（{0}）。请先从 nodejs.org 安装 Node.js（macOS 也可以用 brew install node），然后重试。', spec.command)
    onLine(line)
    return Promise.resolve({ ok: false, output: line })
  }
  const { command, args, shell } = windowsSafe(spec.command, spec.args ?? [])
  return new Promise((resolve) => {
    let output = ''
    let rest = ''
    const feed = (chunk: string) => {
      const text = rest + chunk
      output += chunk
      const lines = text.split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    }
    // A character split across two chunks stays whole; on Windows a console's code page reads right too.
    const out = outputDecoder()
    const err = outputDecoder()
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { env: commandEnv(), shell, windowsHide: true })
    } catch (e) {
      onLine(String(e))
      return resolve({ ok: false, output: String(e) })
    }
    const timer = setTimeout(() => endTree(child), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => feed(out.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => feed(err.write(chunk)))
    child.on('error', (e) => {
      onLine(e.message)
      output += e.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      feed(out.end() + err.end())
      if (rest.trim()) onLine(rest)
      // Node from the nodejs.org installer keeps global packages in a folder only an administrator can write.
      if (code !== 0 && /^npm$/i.test(spec.command) && /EACCES/.test(output) && process.platform !== 'win32') {
        const hint = t('npm 没有权限写入全局安装目录。可以在终端运行 npm config set prefix ~/.npm-global，然后重试（Fenn Code 会在 ~/.npm-global/bin 里找到它）。')
        onLine(hint)
        output += '\n' + hint
      }
      resolve({ ok: code === 0, output })
    })
  })
}

/**
 * npm's global bin folder (where `npm install -g` puts programs), or undefined.
 * On Windows it is the prefix itself; elsewhere prefix/bin.
 */
export function npmGlobalBin(): Promise<string | undefined> {
  const { command, args, shell } = windowsSafe('npm', ['prefix', '-g'])
  return new Promise((resolve) => {
    const child = execFile(command, args, { env: commandEnv(), shell, windowsHide: true }, (err, stdout) => {
      clearTimeout(timer)
      const prefix = String(stdout).trim().split(/\r?\n/).pop()?.trim()
      if (err || !prefix) return resolve(undefined)
      resolve(process.platform === 'win32' ? prefix : join(prefix, 'bin'))
    })
    const timer = setTimeout(() => endTree(child), 30_000)
  })
}

/** Puts a folder at the front of this app's PATH, so programs installed there are found without a restart. */
export function addToPath(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const parts = (env[key] ?? '').split(delimiter)
  if (!parts.includes(dir)) env[key] = [dir, ...parts.filter(Boolean)].join(delimiter)
}
