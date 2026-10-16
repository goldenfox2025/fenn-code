import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findOnPath } from './install'

function realPath(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Use the real Node runtime and JS entry when npm exposes Qoder through a symlink. */
export function qoderCommand(config: Record<string, string>, args: string[]): {
  command: string; args: string[]; requires?: string[]
} {
  const requested = config.QODER_CLI_PATH?.trim() || 'qodercli'
  const launcher = findOnPath(requested) ?? requested
  let entry = realPath(launcher)
  // Windows npm shims are not symlinks. Resolve the package's known entry so
  // stopping a read-only probe stops Node itself rather than only cmd.exe.
  if (/\.(?:cmd|ps1)$/i.test(launcher)) {
    const base = dirname(launcher)
    entry = [join(base, 'node_modules/@qoder-ai/qodercli/bundle/qodercli.js'),
      join(base, '../@qoder-ai/qodercli/bundle/qodercli.js')].find((p) => findOnPath(p)) ?? entry
    entry = realPath(entry)
  }
  if (!/\.[cm]?js$/i.test(entry)) return { command: launcher, args }

  // nvm/npm place node beside the qodercli symlink. Prefer that runtime over
  // a different Node installation that happens to be earlier on PATH.
  const node = config.QODER_NODE_PATH?.trim()
    || findOnPath(join(dirname(launcher), process.platform === 'win32' ? 'node.exe' : 'node'))
    || findOnPath('node') || 'node'
  return { command: realPath(node), args: [entry, ...args], requires: [entry] }
}
