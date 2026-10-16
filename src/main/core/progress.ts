/**
 * The project progress board as plain data: milestones with optional tasks.
 * Pure functions, so the app, the agent tools and tests share one behaviour.
 */
import { randomUUID } from 'node:crypto'
import type { ProgressItem, ProgressPatch, ProgressStatus } from '../../shared/model'

export const STATUSES: ProgressStatus[] = ['todo', 'doing', 'blocked', 'done']

/** Accepts the words models tend to use for a status. */
export function statusOf(v: unknown): ProgressStatus | undefined {
  const s = String(v ?? '').trim().toLowerCase()
  if (!s) return undefined
  if (/^(done|complete|completed|finished|resolved|ok|✓|完成|已完成|done!)$/.test(s)) return 'done'
  if (/^(doing|in[_ -]?progress|active|working|started|wip|✱|进行中|正在做)$/.test(s)) return 'doing'
  if (/^(blocked|stuck|waiting|on[_ -]?hold|卡住|受阻|阻塞)$/.test(s)) return 'blocked'
  if (/^(todo|to[_ -]?do|pending|planned|not[_ -]?started|open|○|未开始|待办)$/.test(s)) return 'todo'
  return undefined
}

export function findItem(items: ProgressItem[], id: string): { item: ProgressItem; parent?: ProgressItem } | undefined {
  for (const m of items) {
    if (m.id === id) return { item: m }
    for (const c of m.children ?? []) if (c.id === id) return { item: c, parent: m }
  }
  return undefined
}

/** Finds an item by id, id prefix, or (case-insensitive) exact title. */
export function resolveItem(items: ProgressItem[], ref: string): ProgressItem | undefined {
  const r = ref.trim()
  if (!r) return undefined
  const all = items.flatMap((m) => [m, ...(m.children ?? [])])
  const one = (list: ProgressItem[]) => (list.length === 1 ? list[0] : undefined)
  return (
    all.find((x) => x.id === r) ??
    (r.length >= 4 ? one(all.filter((x) => x.id.startsWith(r))) : undefined) ??
    one(all.filter((x) => x.title.trim().toLowerCase() === r.toLowerCase()))
  )
}

const DUE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Adds or changes one item and returns the new board plus the item. A
 * milestone's status follows its tasks when they all agree (all done → done).
 */
export function applyPatch(
  items: ProgressItem[],
  patch: ProgressPatch,
  by: ProgressItem['by'],
  now = Date.now()
): { items: ProgressItem[]; item: ProgressItem } {
  const next = structuredClone(items)
  if (patch.due && !DUE.test(patch.due)) throw new Error('截止日期请用 YYYY-MM-DD 格式')
  let item: ProgressItem
  const found = patch.id ? findItem(next, patch.id) : undefined
  if (patch.id && !found) throw new Error(`没有这个进度项：${patch.id}`)
  if (found) {
    item = found.item
  } else {
    const title = patch.title?.trim()
    if (!title) throw new Error('新的进度项需要标题')
    item = { id: randomUUID().slice(0, 8), title, status: 'todo', createdAt: now, updatedAt: now }
    if (patch.parentId) {
      const parent = findItem(next, patch.parentId)
      if (!parent) throw new Error(`没有这个里程碑：${patch.parentId}`)
      // Tasks live one level down; adding under a task adds beside it.
      const milestone = parent.parent ?? parent.item
      ;(milestone.children ??= []).push(item)
    } else next.push(item)
  }
  if (patch.title?.trim()) item.title = patch.title.trim().slice(0, 120)
  if (patch.status) item.status = patch.status
  if (patch.due !== undefined) item.due = patch.due || undefined
  if (patch.note !== undefined) item.note = patch.note.trim().slice(0, 500) || undefined
  if (patch.link?.length) item.links = [...new Set([...(item.links ?? []), ...patch.link])]
  if (patch.suggested !== undefined) item.suggested = patch.suggested || undefined
  item.by = by
  item.updatedAt = now
  rollUp(next, now)
  return { items: next, item }
}

export function removeItem(items: ProgressItem[], id: string, now = Date.now()): ProgressItem[] {
  const next = items.filter((m) => m.id !== id).map((m) => ({ ...m, children: m.children?.filter((c) => c.id !== id) }))
  rollUp(next, now)
  return next
}

/** A milestone with tasks is done when they all are, and in progress once any has started. */
function rollUp(items: ProgressItem[], now: number): void {
  for (const m of items) {
    const kids = m.children ?? []
    if (!kids.length) continue
    const derived: ProgressStatus = kids.every((c) => c.status === 'done')
      ? 'done'
      : kids.some((c) => c.status === 'blocked')
        ? 'blocked'
        : kids.some((c) => c.status !== 'todo')
          ? 'doing'
          : m.status === 'done'
            ? 'todo'
            : m.status
    if (derived !== m.status) {
      m.status = derived
      m.updatedAt = now
    }
  }
}

/** Done and total, counting tasks (or the milestone itself when it has none). */
export function progressCount(items: ProgressItem[]): { done: number; total: number } {
  const leaves = items.filter((m) => !m.suggested).flatMap((m) => (m.children?.length ? m.children.filter((c) => !c.suggested) : [m]))
  return { done: leaves.filter((x) => x.status === 'done').length, total: leaves.length }
}

/** The board as text for an agent. */
export function progressText(items: ProgressItem[]): string {
  if (!items.length) return '（进度表还是空的）'
  const mark: Record<ProgressStatus, string> = { done: '✓', doing: '✱', blocked: '!', todo: '○' }
  const line = (x: ProgressItem, indent: string) =>
    `${indent}${mark[x.status]} ${x.title} [id:${x.id}]${x.due ? ` 截止 ${x.due}` : ''}${x.suggested ? '（建议，待用户确认）' : ''}${x.note ? ` — ${x.note}` : ''}`
  return items.flatMap((m) => [line(m, ''), ...(m.children ?? []).map((c) => line(c, '  '))]).join('\n')
}
