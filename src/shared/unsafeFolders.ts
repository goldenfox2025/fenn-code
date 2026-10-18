/**
 * Folders a conversation may never work in: the user's home folder and every
 * folder above it, a drive or filesystem root, and Fenn Code's own data folder.
 * An agent working there sees everything the user owns. `foldCase`: the file system ignores case
 * (macOS), so /Users/Me is the home folder /Users/me.
 */
export function isUnsafeFolder(path: string, home: string, dataDir: string, foldCase = false): boolean {
  const win = /^[A-Za-z]:|^\\\\/.test(path) || /^[A-Za-z]:/.test(home)
  const norm = (p: string) => {
    const s = p.trim().replace(/[\\/]+$/, '')
    return win ? s.replace(/\//g, '\\').toLowerCase() : foldCase ? s.toLowerCase() : s
  }
  const p = norm(path)
  if (!p || p === '/' || /^[a-z]:$/i.test(p)) return true
  const sep = win ? '\\' : '/'
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + sep)
  const h = norm(home)
  const d = norm(dataDir)
  return (!!h && within(h, p)) || (!!d && within(p, d))
}
