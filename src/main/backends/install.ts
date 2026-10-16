/** Finding the programs backends run. Ancora never installs one unless the user asks in Settings. */
import { statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

/** Finds a program on PATH (like `which`), honouring PATHEXT on Windows. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/[\\/]/.test(name)) {
    try { return statSync(name).isFile() ? name : undefined } catch { return undefined }
  }
  const exts = process.platform === 'win32' && !extname(name) ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, name + ext)
      try {
        if (statSync(p).isFile()) return p
      } catch {
        /* not here */
      }
    }
  }
  return undefined
}
