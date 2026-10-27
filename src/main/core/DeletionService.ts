import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { Conversation, DeletionFolder, DeletionPlan, DeletionTarget } from '../../shared/model'
import { t } from '../../shared/i18n'
import type { Store } from '../store/Store'

export interface DeletionScope { conversations: Set<string>; projects: Set<string>; routines: Set<string> }
interface PathInfo { real: string; identity: string; directory: boolean; link: boolean }
const real = (path: string) => { try { return realpathSync(path) } catch { return resolve(path) } }
const normalized = (path: string) => {
  const value = real(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value
}
export const containsFolder = (outer: string, inner: string) => { const a = normalized(outer), b = normalized(inner); return a === b || b.startsWith(a + sep) }
const overlaps = (a: string, b: string) => containsFolder(a, b) || containsFolder(b, a)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const inspect = (path: string): PathInfo | undefined => {
  try {
    const entry = lstatSync(path, { bigint: true }), directory = statSync(path).isDirectory()
    return { real: real(path), identity: `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`, directory, link: entry.isSymbolicLink() }
  } catch { return undefined }
}

/** Directory deletion is opt-in at execution, revalidated, and always uses the OS trash. */
export class DeletionService {
  private tail: Promise<void> = Promise.resolve()
  private lockedFolders: string[] = []
  private deleting = new Set<string>()
  constructor(private store: Store, private deps: {
    folderOf: (conversation: Conversation) => string | undefined
    protected: (path: string) => boolean
    stop: (ids: Set<string>) => Promise<void>
    remove: (scope: DeletionScope) => Promise<void>
    trash: (path: string) => Promise<void>
  }) {}

  assertFolderAvailable(path?: string): void {
    if (path && this.lockedFolders.some(folder => overlaps(path, folder))) throw new Error(t('这个文件夹正在移到回收站，请稍后重试。'))
  }
  assertConversationAvailable(id: string): void {
    if (this.deleting.has(id)) throw new Error(t('这个对话正在删除，请稍后重试。'))
  }

  private scope(targets: DeletionTarget[]): DeletionScope {
    const projects = new Set(targets.filter(target => target.kind === 'project' && this.store.project(target.id)).map(target => target.id))
    const conversations = new Set<string>()
    for (const id of projects) {
      conversations.add(this.store.requireProject(id).conversationId)
      for (const c of this.store.conversations) if (c.projectId === id && c.kind !== 'chat') conversations.add(c.id)
    }
    for (const target of targets) if (target.kind === 'conversation') {
      const c = this.store.conversation(target.id)
      if (!c) continue
      if (c.kind === 'project' && this.store.project(c.projectId) && !projects.has(c.projectId!)) throw new Error(t('这是项目的主对话，不能单独删除。要删除，请删除整个项目。'))
      conversations.add(c.id)
    }
    const routines = new Set(this.store.routines.filter(r => !!r.target.projectId && projects.has(r.target.projectId) || !!r.target.conversationId && conversations.has(r.target.conversationId)).map(r => r.id))
    return { projects, conversations, routines }
  }

  plan(input: DeletionTarget[]): DeletionPlan {
    const targets = [...new Map(input.filter(target => target && ['project', 'conversation'].includes(target.kind) && typeof target.id === 'string').map(target => [`${target.kind}:${target.id}`, target])).values()]
      .filter(target => target.kind === 'project' ? !!this.store.project(target.id) : !!this.store.conversation(target.id))
    const scope = this.scope(targets)
    const refs: { path: string; title: string }[] = []
    for (const p of this.store.projects) if (!scope.projects.has(p.id) && p.cwd) refs.push({ path: p.cwd, title: p.name })
    for (const c of this.store.conversations) if (!scope.conversations.has(c.id)) {
      const path = this.deps.folderOf(c)
      if (path) refs.push({ path, title: c.title })
      if (c.workspace) refs.push({ path: c.workspace.root, title: c.title })
    }
    const folders = new Map<string, DeletionFolder & { identity?: string; real: string }>()
    const add = (path: string | undefined, automatic: boolean) => {
      if (!path) return
      path = resolve(path)
      const info = inspect(path), id = hash([info?.identity ?? path, resolve(path)]).slice(0, 24)
      const existing = [...folders.values()].find(folder => info ? folder.identity === info.identity : !folder.identity && resolve(folder.path) === path)
      if (existing) { existing.automatic ||= automatic; return }
      const usedBy = [...new Set(refs.filter(ref => overlaps(path!, ref.path)).map(ref => ref.title))]
      const state = !info?.directory ? 'missing' : this.deps.protected(path) || this.deps.protected(info.real) ? 'protected' : usedBy.length ? 'shared' : 'available'
      folders.set(id, { id, path, automatic, state, usedBy, identity: info?.identity, real: info?.real ?? path })
    }
    for (const id of scope.projects) { const p = this.store.requireProject(id); add(p.cwd, !!p.autoFolder) }
    for (const id of scope.conversations) {
      const c = this.store.conversation(id)
      if (c) {
        add(this.deps.folderOf(c), !!c.autoFolder || !!c.workspace && c.cwd === c.workspace.path)
        if (c.workspace) add(c.workspace.path, true)
      }
    }
    for (const id of scope.conversations) {
      const workspace = this.store.conversation(id)?.workspace
      if (!workspace) continue
      const checkout = [...folders.values()].find(folder => containsFolder(folder.path, workspace.path) && containsFolder(workspace.path, folder.path))
      if (!checkout || checkout.state === 'missing') continue
      for (const folder of folders.values()) if (folder.id !== checkout.id && containsFolder(folder.path, workspace.root)) {
        if (checkout.state !== 'available') { folder.state = 'shared'; folder.usedBy = [...new Set([...folder.usedBy, ...checkout.usedBy])] }
        else folder.requiredFolderIds = [...new Set([...(folder.requiredFolderIds ?? []), checkout.id])]
      }
    }
    const retained = this.store.conversations.filter(c => !scope.conversations.has(c.id) && (!!c.parentId && scope.conversations.has(c.parentId) || !!c.projectId && scope.projects.has(c.projectId)))
    const items = targets.map(target => ({ ...target, title: target.kind === 'project' ? this.store.requireProject(target.id).name : this.store.requireConversation(target.id).title }))
    const revision = hash({ items, projects: [...scope.projects].sort(), conversations: [...scope.conversations].sort(), routines: [...scope.routines].sort(), folders: [...folders.values()], retained: retained.map(c => c.id).sort() })
    return { revision, targets, items, folders: [...folders.values()].map(({ identity: _identity, real: _real, ...folder }) => folder), retainedConversations: retained.length, routinesToDisable: this.store.routines.filter(r => scope.routines.has(r.id) && r.enabled).length }
  }

  execute(targets: DeletionTarget[], revision?: string, trashFolderIds: string[] = []): Promise<void> {
    const task = this.tail.then(async () => {
      const plan = this.plan(targets)
      if (revision && revision !== plan.revision) throw new Error(t('删除范围发生变化，请重新确认。'))
      const selected = [...new Set(trashFolderIds)].map(id => {
        const folder = plan.folders.find(folder => folder.id === id)
        if (!folder || folder.state !== 'available') throw new Error(t('删除范围发生变化，请重新确认。'))
        return { ...folder, info: inspect(folder.path)! }
      })
      if (selected.some(folder => folder.requiredFolderIds?.some(id => !selected.some(item => item.id === id)))) throw new Error(t('保留独立工作区时，也需保留主仓库文件夹。'))
      const roots = selected.filter(folder => !selected.some(parent => parent !== folder && !parent.info.link && resolve(parent.path) !== resolve(folder.path) && resolve(folder.path).startsWith(resolve(parent.path) + sep)))
      const scope = this.scope(plan.targets)
      this.lockedFolders = roots.flatMap(folder => [folder.path, folder.info.real])
      this.deleting = scope.conversations
      try {
        await this.deps.stop(scope.conversations)
        if ((revision || roots.length) && this.plan(plan.targets).revision !== plan.revision) throw new Error(t('删除范围发生变化，请重新确认。'))
        for (const folder of roots) {
          if (inspect(folder.path)?.identity !== folder.info.identity || this.plan(plan.targets).folders.find(item => item.id === folder.id)?.state !== 'available') throw new Error(t('删除范围发生变化，请重新确认。'))
          try { await this.deps.trash(folder.path) }
          catch (error) {
            console.warn('[deletion] trash failed', folder.path, error)
            throw new Error(t('没能将「{0}」移到回收站，删除记录的操作尚未执行。已移入的文件夹可从回收站恢复。', folder.path))
          }
        }
        await this.deps.remove(scope)
      } finally { this.lockedFolders = []; this.deleting = new Set() }
    })
    this.tail = task.catch(() => {})
    return task
  }
}
