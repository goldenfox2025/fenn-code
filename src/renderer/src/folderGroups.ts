import type { Conversation } from '@shared/model'
import { t } from './i18n'

/** Chats that work in the same folder, like Claude Code's folder-based sessions. */
export interface FolderGroup {
  key: string
  /** Unset for chats without a folder. */
  folder?: string
  name: string
  chats: Conversation[]
}

/** A sub-conversation whose parent is listed too (drawn nested under it). */
export const isNested = (c: Conversation, all: Conversation[]) => !!c.parentId && all.some((x) => x.id === c.parentId)

export const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

const keyOf = (folder?: string) => (folder ? folder.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() : '')

/**
 * Groups chats by working folder, the most recently active group first; chats
 * without a folder form one group of their own. Two folders with the same name
 * show their parent folder too.
 */
export function groupByFolder(chats: Conversation[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>()
  const ids = new Set(chats.map((c) => c.id))
  // Sub-conversations sit right under their parent, in its group.
  const children = new Map<string, Conversation[]>()
  for (const c of chats) if (c.parentId && ids.has(c.parentId)) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c])
  for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (c.parentId && ids.has(c.parentId)) continue
    const key = keyOf(c.cwd)
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key: key || '~none', folder: c.cwd || undefined, name: c.cwd ? folderName(c.cwd) : t('对话'), chats: [] }))
    g.chats.push(c, ...(children.get(c.id) ?? []).sort((a, b) => a.createdAt - b.createdAt))
  }
  const list = [...groups.values()]
  const names = new Map<string, number>()
  for (const g of list) if (g.folder) names.set(g.name, (names.get(g.name) ?? 0) + 1)
  for (const g of list)
    if (g.folder && (names.get(g.name) ?? 0) > 1) {
      const parts = g.folder.replace(/[\\/]+$/, '').split(/[\\/]/)
      g.name = parts.slice(-2).join('/')
    }
  return list
}
