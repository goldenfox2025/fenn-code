import type { UpgradeSpec } from '../../shared/contract'
import { tk } from '../../shared/i18n'

/**
 * A follow-up step for `npm install -g <pkg>`: npm may skip a package's own
 * install script (e.g. under an allow-scripts policy), which leaves its program
 * unusable. This runs the script only when `<bin> --version` doesn't work.
 */
export function finishNpmInstall(bin: string, pkg: string, script: string): NonNullable<UpgradeSpec['after']> {
  // One line: on Windows `node` runs through cmd.exe (see windowsSafe), which ends the command at a newline.
  const code = [
    `const { execSync, spawnSync } = require('child_process')`,
    `const path = require('path')`,
    `const v = spawnSync(${JSON.stringify(bin)}, ['--version'], { shell: process.platform === 'win32', encoding: 'utf8', windowsHide: true })`,
    `if (v.status === 0 && /\\d+\\.\\d+/.test(v.stdout)) { console.log(${JSON.stringify(bin)} + ' ' + v.stdout.trim()); process.exit(0) }`,
    `const root = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim()`,
    `const r = spawnSync(process.execPath, [path.join(root, ...${JSON.stringify(pkg.split('/'))}, ...${JSON.stringify(script.split('/'))})], { stdio: 'inherit', windowsHide: true })`,
    `if (r.status === 0) console.log('ran ' + ${JSON.stringify(script)})`,
    `process.exit(r.status ?? 1)`
  ].join('; ')
  return { command: 'node', args: ['-e', code], label: tk('检查 {0} 能否运行，必要时补跑它的安装脚本（{1}）'), labelArgs: [bin, script.split('/').pop()] }
}
