import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findOnPath } from './install'

function realPath(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/**
 * Runs an npm-installed command line as `node <its script>` rather than through npm's launcher.
 * On Windows the launcher is a .cmd shim, which costs a cmd.exe and a second start-up, and
 * stopping it stops only cmd.exe; elsewhere it is a symlink to the script.
 *
 * `entry` is the script inside the package (e.g. `@agentclientprotocol/codex-acp/dist/index.js`),
 * looked up beside the shim the way npm lays out a global install.
 */
export function nodeScript(requested: string, entry: string, args: string[], node?: string): {
  command: string; args: string[]; requires?: string[]
} {
  const launcher = findOnPath(requested) ?? requested
  let script = realPath(launcher)
  if (/\.(?:cmd|ps1)$/i.test(launcher)) {
    const base = dirname(launcher)
    script = realPath([join(base, 'node_modules', entry), join(base, '..', entry)].find((p) => findOnPath(p)) ?? script)
  }
  if (!/\.[cm]?js$/i.test(script)) return { command: launcher, args }
  // npm and nvm put node beside the launcher: prefer that runtime over another Node earlier on PATH.
  const runtime = node?.trim() || findOnPath(join(dirname(launcher), process.platform === 'win32' ? 'node.exe' : 'node')) || findOnPath('node') || 'node'
  return { command: realPath(runtime), args: [script, ...args], requires: [script] }
}

/** The directory of the npm package a `nodeScript` entry lives in (`…/node_modules/<name>`), when it is one. */
export function packageDir(script: string, name: string): string | undefined {
  const i = script.replace(/\\/g, '/').lastIndexOf(`/node_modules/${name}/`)
  return i < 0 ? undefined : script.slice(0, i + `/node_modules/${name}`.length)
}
