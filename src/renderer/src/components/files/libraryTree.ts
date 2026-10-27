import type { LibraryEntry } from '@shared/model'

export const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
export const baseName = (path: string) => path.split('/').pop() ?? path
export const under = (path: string, root: string) => path === root || path.startsWith(root + '/')
export const moved = (path: string, from: string, to: string) => under(path, from) ? to + path.slice(from.length) : path

/** Keep cached branches coherent until the refreshed filesystem listings arrive. */
export function relocateTree(dirs: Record<string, LibraryEntry[]>, from: string, to: string): Record<string, LibraryEntry[]> {
  const result: Record<string, LibraryEntry[]> = {}
  const entry = dirs[parentOf(from)]?.find(e => e.path === from)
  for (const [directory, entries] of Object.entries(dirs)) {
    result[moved(directory, from, to)] = entries.filter(e => e.path !== from || parentOf(from) === parentOf(to)).map(e => under(e.path, from) ? { ...e, path: moved(e.path, from, to), ...(e.path === from ? { name: baseName(to) } : {}) } : e)
  }
  if (entry && parentOf(from) !== parentOf(to) && result[parentOf(to)]) {
    result[parentOf(to)] = [...result[parentOf(to)], { ...entry, path: to, name: baseName(to) }].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  }
  return result
}
