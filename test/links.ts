import { symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TestContext } from 'vitest'

/**
 * Makes a link for a test. A folder link is a junction on Windows, which needs no special rights. A file link
 * there needs Developer Mode or admin rights; without them the test is skipped, saying why, rather than failed.
 */
export function link(ctx: TestContext, target: string, path: string, kind: 'dir' | 'file' = 'file'): void {
  if (kind === 'dir') return symlinkSync(process.platform === 'win32' ? resolve(target) : target, path, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    symlinkSync(target, path, 'file')
  } catch (e) {
    if (process.platform === 'win32' && (e as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('Windows makes file links only with Developer Mode or admin rights')
    throw e
  }
}
