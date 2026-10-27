import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeCore, until } from './helpers'
import type { Conversation, DeletionTarget } from '../src/shared/model'

const target = (id: string, kind: DeletionTarget['kind'] = 'conversation'): DeletionTarget => ({ kind, id })
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'fenn-delete-'))
  const setup = await makeCore(join(base, 'data'))
  setup.core.documentsDir = join(base, 'Documents')
  mkdirSync(setup.core.documentsDir)
  const trash = join(base, 'trash'); mkdirSync(trash)
  const moved: { from: string; to: string }[] = []
  const trashFolder = async (path: string) => {
    if (!resolve(path).startsWith(resolve(base) + sep)) throw new Error('Not a fixture path')
    const to = join(trash, `${moved.length}-${basename(path)}`)
    renameSync(path, to); moved.push({ from: path, to })
  }
  setup.core.shellTrash = trashFolder
  const create = (options: Partial<Conversation>) => setup.core.chat.createConversation({ kind: 'chat', title: 'Fixture', backendId: 'mock', ...options })
  const automatic = async (title = 'Auto') => {
    const conversation = create({ title })
    const path = await setup.core.makeDefaultFolder(conversation.id)
    writeFileSync(join(path, 'notes.txt'), 'keep recoverable')
    return { conversation, path }
  }
  return { ...setup, base, moved, automatic, trashFolder, create }
}

describe('reviewed deletion and recoverable folders', () => {
  it('trashes an explicitly selected automatic folder before removing its conversation', async () => {
    const f = await fixture()
    try {
      const { conversation, path } = await f.automatic()
      const plan = await f.core.deletionPlan([target(conversation.id)])
      expect(plan.folders).toMatchObject([{ path, automatic: true, state: 'available' }])
      await f.core.deleteSelection(plan.targets, plan.revision, plan.folders.map(folder => folder.id))
      expect(f.store.conversation(conversation.id)).toBeUndefined()
      expect(existsSync(path)).toBe(false)
      expect(readFileSync(join(f.moved[0].to, 'notes.txt'), 'utf8')).toBe('keep recoverable')
    } finally { await f.dispose() }
  })

  it('keeps folders for record-only deletion, including legacy callers', async () => {
    const f = await fixture()
    try {
      const { conversation, path } = await f.automatic()
      await f.core.deleteConversation(conversation.id)
      expect(existsSync(join(path, 'notes.txt'))).toBe(true)
      expect(f.moved).toHaveLength(0)
      const manual = f.create({ title: 'Manual', cwd: path })
      const plan = await f.core.deletionPlan([target(manual.id)])
      expect(plan.folders[0].automatic).toBe(false)
      await f.core.deleteSelection(plan.targets, plan.revision, [])
      expect(existsSync(path)).toBe(true)
    } finally { await f.dispose() }
  })

  it('records project ownership at creation and clears it when the user selects a folder', async () => {
    const f = await fixture()
    try {
      const project = await f.core.createProject({ name: 'Owned', backendId: 'mock' })
      expect(project.autoFolder).toBe(true)
      expect((await f.core.deletionPlan([target(project.id, 'project')])).folders[0].automatic).toBe(true)
      await f.core.updateProject(project.id, { cwd: project.cwd })
      expect(f.store.requireProject(project.id).autoFolder).toBeUndefined()
      await f.core.updateProject(project.id, { cwd: undefined })
      await f.core.makeDefaultFolder(project.id)
      expect(f.store.requireProject(project.id).autoFolder).toBe(true)
    } finally { await f.dispose() }
  })

  it('protects a folder still used by another conversation, including descendant folders', async () => {
    const f = await fixture()
    try {
      const { conversation, path } = await f.automatic()
      const child = join(path, 'child'); mkdirSync(child)
      const other = f.create({ title: 'Other', cwd: child })
      const plan = await f.core.deletionPlan([target(conversation.id)])
      expect(plan.folders[0]).toMatchObject({ state: 'shared', usedBy: ['Other'] })
      await expect(f.core.deleteSelection(plan.targets, plan.revision, [plan.folders[0].id])).rejects.toThrow()
      await f.core.deleteSelection(plan.targets, plan.revision, [])
      expect(f.store.conversation(other.id)).toBeDefined()
      expect(existsSync(child)).toBe(true)
    } finally { await f.dispose() }
  })

  it('evaluates bulk references together and trashes a shared selected directory once', async () => {
    const f = await fixture()
    try {
      const { conversation, path } = await f.automatic()
      const other = f.create({ title: 'Also selected', cwd: path })
      const plan = await f.core.deletionPlan([target(conversation.id), target(other.id)])
      expect(plan.folders).toHaveLength(1)
      expect(plan.folders[0].state).toBe('available')
      await f.core.deleteSelection(plan.targets, plan.revision, [plan.folders[0].id])
      expect(f.moved).toHaveLength(1)
      expect(f.store.conversations).toHaveLength(0)
    } finally { await f.dispose() }
  })

  it('keeps a project folder for preserved ordinary chats and preserves their effective cwd', async () => {
    const f = await fixture()
    try {
      const project = await f.core.createProject({ name: 'Project', backendId: 'mock' })
      const conversation = f.create({ title: 'Preserved' })
      f.store.putConversation({ ...conversation, projectId: project.id, cwd: undefined })
      const plan = await f.core.deletionPlan([target(project.id, 'project')])
      expect(plan.retainedConversations).toBe(1)
      expect(plan.folders[0].state).toBe('shared')
      await f.core.deleteSelection(plan.targets, plan.revision, [])
      expect(f.store.project(project.id)).toBeUndefined()
      expect(f.store.requireConversation(conversation.id)).toMatchObject({ cwd: project.cwd, projectId: undefined })
      expect(existsSync(project.cwd!)).toBe(true)
    } finally { await f.dispose() }
  })

  it('rejects a stale review when a new reference appears or the directory is replaced', async () => {
    const f = await fixture()
    try {
      const { conversation, path } = await f.automatic()
      const plan = await f.core.deletionPlan([target(conversation.id)])
      f.create({ title: 'New reference', cwd: path })
      await expect(f.core.deleteSelection(plan.targets, plan.revision, [plan.folders[0].id])).rejects.toThrow()
      expect(f.store.conversation(conversation.id)).toBeDefined()
      const another = await f.automatic('Replacement')
      const before = await f.core.deletionPlan([target(another.conversation.id)])
      renameSync(another.path, another.path + '-original'); mkdirSync(another.path)
      await expect(f.core.deleteSelection(before.targets, before.revision, [before.folders[0].id])).rejects.toThrow()
      expect(f.moved).toHaveLength(0)
    } finally { await f.dispose() }
  })

  it('keeps every record on partial trash failure and can retry the remaining folders', async () => {
    const f = await fixture()
    try {
      const first = await f.automatic('First'), second = await f.automatic('Second')
      const plan = await f.core.deletionPlan([target(first.conversation.id), target(second.conversation.id)])
      f.core.shellTrash = async path => { if (path === second.path) throw new Error('fixture refusal'); await f.trashFolder(path) }
      await expect(f.core.deleteSelection(plan.targets, plan.revision, plan.folders.map(folder => folder.id))).rejects.toThrow()
      expect(f.store.conversation(first.conversation.id)).toBeDefined()
      expect(f.store.conversation(second.conversation.id)).toBeDefined()
      expect(existsSync(second.path)).toBe(true)
      expect(readFileSync(join(f.moved[0].to, 'notes.txt'), 'utf8')).toBe('keep recoverable')
      f.core.shellTrash = f.trashFolder
      const retry = await f.core.deletionPlan(plan.targets)
      await f.core.deleteSelection(retry.targets, retry.revision, retry.folders.filter(folder => folder.state === 'available').map(folder => folder.id))
      expect(f.store.conversations).toHaveLength(0)
      expect(f.moved).toHaveLength(2)
    } finally { await f.dispose() }
  })

  it('locks folder adoption during trash, and never falls back to permanent removal', async () => {
    const f = await fixture()
    try {
      const { conversation, path } = await f.automatic()
      const other = f.create({ title: 'Late permission event' })
      const plan = await f.core.deletionPlan([target(conversation.id)])
      let release!: () => void, entered = false
      f.core.shellTrash = async path => { entered = true; await new Promise<void>(resolve => { release = resolve }); await f.trashFolder(path) }
      const deleting = f.core.deleteSelection(plan.targets, plan.revision, [plan.folders[0].id])
      await until(() => entered)
      await expect(f.core.startChat({ text: 'must be refused before sending', cwd: path, backendId: 'mock' })).rejects.toThrow()
      expect(() => f.core.chat.hooks.adoptFolder?.(other.id, path)).not.toThrow()
      expect(f.store.requireConversation(other.id).cwd).toBeUndefined()
      expect(f.store.conversation(conversation.id)).toBeDefined()
      release(); await deleting
      const another = await f.automatic('No trash')
      const next = await f.core.deletionPlan([target(another.conversation.id)])
      f.core.shellTrash = undefined
      await expect(f.core.deleteSelection(next.targets, next.revision, [next.folders[0].id])).rejects.toThrow()
      expect(existsSync(another.path)).toBe(true)
      expect(f.store.conversation(another.conversation.id)).toBeDefined()
    } finally { await f.dispose() }
  })

  it('protects the documents/default container and refuses standalone project-chat deletion', async () => {
    const f = await fixture()
    try {
      const conversation = f.create({ cwd: f.core.documentsDir })
      expect((await f.core.deletionPlan([target(conversation.id)])).folders[0].state).toBe('protected')
      const project = await f.core.createProject({ name: 'Project', backendId: 'mock' })
      await expect(f.core.deletionPlan([target(project.conversationId)])).rejects.toThrow()
    } finally { await f.dispose() }
  })
  it('keeps a Git common directory when an owned checkout is kept', async () => {
    const f = await fixture()
    try {
      const project = await f.core.createProject({ name: 'Repository', backendId: 'mock' })
      const checkout = join(f.base, 'checkout'); mkdirSync(checkout); writeFileSync(join(checkout, 'work.txt'), 'unmerged work')
      f.core.chat.createConversation({ kind: 'thread', title: 'Worker', projectId: project.id, backendId: 'mock', cwd: checkout, workspace: { root: project.cwd!, path: checkout, branch: 'worker', targetBranch: 'main', base: 'fixture' } })
      const plan = await f.core.deletionPlan([target(project.id, 'project')])
      const repository = plan.folders.find(folder => folder.path === project.cwd)!
      const worktree = plan.folders.find(folder => folder.path === checkout)!
      expect(repository.requiredFolderIds).toEqual([worktree.id])
      await expect(f.core.deleteSelection(plan.targets, plan.revision, [repository.id])).rejects.toThrow()
      expect(f.moved).toHaveLength(0)
      await f.core.deleteSelection(plan.targets, plan.revision, [repository.id, worktree.id])
      expect(f.moved).toHaveLength(2)
      expect(readFileSync(join(f.moved.find(item => item.from === checkout)!.to, 'work.txt'), 'utf8')).toBe('unmerged work')
    } finally { await f.dispose() }
  })
})
