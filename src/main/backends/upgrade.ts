/**
 * Running a backend's own upgrade command (e.g. `npm install -g some-cli@latest`)
 * and asking what the latest version is. Output streams back line by line.
 */
import { execFile, spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import type { CommandSpec } from '../../shared/contract'
import { windowsSafe } from './acp/AcpBackend'

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
    execFile(command, args, { env: commandEnv(), shell, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : String(stdout).match(VERSION)?.[0])
    })
  })
}

/** Runs the command, passing each output line on; resolves with whether it succeeded. */
export function runStreaming(spec: CommandSpec, onLine: (line: string) => void, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; output: string }> {
  const { command, args, shell } = windowsSafe(spec.command, spec.args ?? [])
  return new Promise((resolve) => {
    let output = ''
    let rest = ''
    const feed = (chunk: Buffer) => {
      const text = rest + chunk.toString()
      output += chunk.toString()
      const lines = text.split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { env: commandEnv(), shell, windowsHide: true })
    } catch (e) {
      onLine(String(e))
      return resolve({ ok: false, output: String(e) })
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    child.on('error', (e) => {
      onLine(e.message)
      output += e.message
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (rest.trim()) onLine(rest)
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
    execFile(command, args, { env: commandEnv(), shell, timeout: 30_000, windowsHide: true }, (err, stdout) => {
      const prefix = String(stdout).trim().split(/\r?\n/).pop()?.trim()
      if (err || !prefix) return resolve(undefined)
      resolve(process.platform === 'win32' ? prefix : join(prefix, 'bin'))
    })
  })
}

/** Puts a folder at the front of this app's PATH, so programs installed there are found without a restart. */
export function addToPath(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const parts = (env[key] ?? '').split(delimiter)
  if (!parts.includes(dir)) env[key] = [dir, ...parts.filter(Boolean)].join(delimiter)
}
