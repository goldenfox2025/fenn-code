import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Conversation, DeliveryReview, ReviewFileContent, ThreadWorkspace } from '../../shared/model'
import type { Store } from '../store/Store'
import type { ChatService } from './ChatService'
import { t } from '../../shared/i18n'

const execute = promisify(execFile)
/** Argument arrays only; git never runs through a shell. All probes leave both checkouts untouched. */
export async function projectGit(cwd: string, ...args: string[]): Promise<string> {
  return (await gitText(cwd, ...args)).trim()
}

async function gitText(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', cwd, ...args], {
    windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
  })
  return stdout
}

export class ProjectReviews {
  onSubmitted?: (projectId: string) => void
  onDecided?: (projectId: string) => void
  private preparations = new Map<string, Promise<void>>()
  private locks = new Map<string, Promise<unknown>>()

  constructor(private store: Store, private chat: ChatService) {
    chat.turnStartListeners.add((id) => {
      const c = store.conversation(id)
      if (c?.review && !['returned', 'stale', 'merging'].includes(c.review.state))
        this.chat.patchConversation(id, { resolved: false, review: { ...c.review, state: 'stale', recommendation: undefined } })
    })
    for (const c of store.conversations) if (c.review?.state === 'merging') void this.recover(c)
  }

  private async recover(c: Conversation): Promise<void> {
    const review = c.review!
    if (review.kind === 'finding') {
      this.chat.patchConversation(c.id, { review: { ...review, state: 'accepted', decisionPending: true, decidedAt: Date.now() }, resolved: true, status: 'done' })
      this.notifyDecision(c.id)
      return
    }
    try {
      if (c.workspace && review.head) {
        await projectGit(c.workspace.root, 'merge-base', '--is-ancestor', review.head, `refs/heads/${c.workspace.targetBranch}`)
        const mergeCommit = await projectGit(c.workspace.root, 'rev-parse', `refs/heads/${c.workspace.targetBranch}`)
        this.chat.patchConversation(c.id, { review: { ...review, state: 'accepted', mergeCommit, decisionPending: true, decidedAt: Date.now() }, workspace: { ...c.workspace, base: review.head }, resolved: true, status: 'done' })
        this.notifyDecision(c.id)
        return
      }
    } catch { /* An interrupted or failed merge needs a fresh submission, never a blind retry. */ }
    this.chat.patchConversation(c.id, { review: { ...review, state: 'stale', recommendation: undefined }, resolved: false, status: 'waiting' })
  }

  private async locked<T>(root: string, work: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(root) ?? Promise.resolve()
    const running = prior.catch(() => undefined).then(work)
    this.locks.set(root, running)
    try { return await running } finally { if (this.locks.get(root) === running) this.locks.delete(root) }
  }

  async prepare(conv: Conversation): Promise<void> {
    if (conv.review?.state === 'merging') {
      await this.locks.get(conv.workspace?.root ?? conv.projectId!)
      const fresh = this.store.conversation(conv.id)
      if (fresh?.review && this.chat.isBusy(conv.id)) this.chat.patchConversation(conv.id, { review: { ...fresh.review, state: 'stale', recommendation: undefined }, resolved: false })
    }
    if (conv.workspace && conv.review?.mergeCommit && conv.review.state === 'stale') {
      const w = conv.workspace
      await this.locked(w.root, async () => {
        if (await projectGit(w.path, 'status', '--porcelain', '--untracked-files=all')) return
        if ((await projectGit(w.path, 'rev-parse', 'HEAD')) !== conv.review!.head) return
        // An accepted worker continues from the integrated project, never from an old isolated snapshot.
        await projectGit(w.path, 'merge', '--ff-only', `refs/heads/${w.targetBranch}`)
        const base = await projectGit(w.path, 'rev-parse', 'HEAD')
        this.chat.patchConversation(conv.id, { workspace: { ...w, base } })
      })
    }
    if (!conv.isolateWorkspace || conv.workspace) return
    const pending = this.preparations.get(conv.id)
    if (pending) return pending
    const preparing = this.prepareNew(conv)
    this.preparations.set(conv.id, preparing)
    try { await preparing } finally { this.preparations.delete(conv.id) }
  }

  private async prepareNew(conv: Conversation): Promise<void> {
    const folder = this.store.project(conv.projectId)?.cwd
    if (!folder) return
    let root: string
    try { root = await projectGit(folder, 'rev-parse', '--show-toplevel') }
    catch {
      // Non-code projects keep their normal project folder. Never fall back for a broken Git checkout.
      const { existsSync } = await import('node:fs')
      if (existsSync(join(folder, '.git'))) throw new Error(t('项目 Git 工作区无法读取，请先修复后重试。'))
      return
    }
    // Retarget the agent only after Git isolation is known to be available.
    if (conv.sessionRef) this.chat.rotate(conv.id)
    await this.locked(root, async () => {
      const base = await projectGit(root, 'rev-parse', 'HEAD')
      const targetBranch = await projectGit(root, 'symbolic-ref', '--short', 'HEAD')
      // Keep code checkouts outside app data (which contains private settings), and outside
      // the target checkout so they cannot be staged or counted as untracked project files.
      const worktrees = join(dirname(root), '.fenn-worktrees', basename(root))
      const path = join(worktrees, conv.id)
      await mkdir(worktrees, { recursive: true })
      const branch = `fenn/${conv.id}`
      await projectGit(root, 'worktree', 'add', '-b', branch, path, base)
      if (!this.store.conversation(conv.id)) return
      const workspace: ThreadWorkspace = { root, path, branch, targetBranch, base }
      this.chat.patchConversation(conv.id, { cwd: path, workspace })
    })
  }

  private thread(id: string): Conversation {
    const c = this.store.requireConversation(id)
    if (c.kind !== 'thread' || !this.store.project(c.projectId)) throw new Error(t('只有项目讨论串可以提交验收。'))
    return c
  }

  private revision(id: string, revision: string): { conv: Conversation; review: DeliveryReview } {
    const conv = this.thread(id)
    if (!conv.review || conv.review.id !== revision || conv.review.state !== 'pending')
      throw new Error(t('交付版本已变化，请重新查看最新提交。'))
    return { conv, review: conv.review }
  }

  async submit(id: string, summary: string, checks = '', unverified = '', kind?: 'change' | 'finding'): Promise<DeliveryReview> {
    const c = this.thread(id)
    kind ??= c.taskKind ?? (c.isolateWorkspace ? 'change' : 'finding')
    if (!summary.trim()) throw new Error(t('请填写交付摘要。'))
    await this.prepare(c)
    const fresh = this.thread(id)
    const head = fresh.workspace ? await projectGit(fresh.workspace.path, 'rev-parse', 'HEAD') : undefined
    const review: DeliveryReview = {
      id: randomUUID(), kind, state: 'pending', summary: summary.slice(0, 6000), checks: checks.slice(0, 6000),
      unverified: unverified.slice(0, 6000), submittedAt: Date.now(), head, base: fresh.workspace?.base
    }
    this.chat.patchConversation(id, { review, resolved: false })
    await this.inspect(id, review.id)
    return this.thread(id).review!
  }

  notify(id: string): void {
    const c = this.store.conversation(id)
    if (c?.projectId && c.review?.state === 'pending') this.onSubmitted?.(c.projectId)
  }

  notifyDecision(id: string): void {
    const c = this.store.conversation(id), r = c?.review
    const p = this.store.project(c?.projectId)
    if (!c || !r?.decisionPending || !r.decidedAt || !p) return
    const notice = { id: `${r.id}:${r.decidedAt}`, threadId: c.id, revision: r.id, title: c.title, decision: r.state === 'accepted' ? 'accepted' as const : r.state === 'returned' ? 'returned' as const : 'discussion' as const, kind: r.kind, feedback: r.feedback, continuation: r.continuation, mergeCommit: r.mergeCommit, integrationPlan: r.recommendation?.integrationPlan, at: r.decidedAt }
    const pending = p.pendingReviewDecisions ?? []
    if (!pending.some((item) => item.id === notice.id)) this.store.putProject({ ...p, pendingReviewDecisions: [...pending, notice] })
    this.onDecided?.(p.id)
  }

  async inspect(id: string, revision: string): Promise<DeliveryReview> {
    const { conv, review } = this.revision(id, revision)
    const assessment: NonNullable<DeliveryReview['assessment']> = { files: [], overlaps: [], blockers: [], diff: '' }
    const w = conv.workspace
    if (w) {
      const head = await projectGit(w.path, 'rev-parse', 'HEAD')
      if (head !== review.head) {
        this.chat.patchConversation(id, { review: { ...review, state: 'stale', recommendation: undefined } })
        throw new Error(t('工作分支已变化，请讨论串重新提交验收。'))
      }
      assessment.targetHead = await projectGit(w.root, 'rev-parse', `refs/heads/${w.targetBranch}`)
      const finding = review.kind === 'finding'
      if (!finding && await projectGit(w.path, 'status', '--porcelain', '--untracked-files=all')) assessment.blockers.push(t('工作区有未提交的文件，请先提交再验收。'))
      if (!finding && await projectGit(w.root, 'status', '--porcelain', '--untracked-files=all')) assessment.blockers.push(t('项目目录有未提交的修改，合并前请先处理。'))
      if (!finding && (await projectGit(w.root, 'symbolic-ref', '--short', 'HEAD')) !== w.targetBranch) assessment.blockers.push(t('项目目录已切换分支，请回到原集成分支。'))
      const base = review.base ?? w.base
      const committed = await gitText(w.path, 'diff', '--no-renames', '--name-only', '-z', base, review.head!)
      assessment.files = committed.split('\0').filter(Boolean)
      const numstat = await gitText(w.path, 'diff', '--no-renames', '--numstat', '-z', base, review.head!)
      const statuses = (await gitText(w.path, 'diff', '--no-renames', '--name-status', '-z', base, review.head!)).split('\0')
      const status = new Map<string, string>()
      for (let i = 0; i + 1 < statuses.length; i += 2) status.set(statuses[i + 1], statuses[i])
      assessment.changes = numstat.split('\0').filter(Boolean).map((row) => {
        const [added, removed, ...name] = row.split('\t')
        const path = name.join('\t')
        return { path, status: status.get(path) === 'A' ? 'added' : status.get(path) === 'D' ? 'deleted' : 'modified', added: added === '-' ? undefined : Number(added), removed: removed === '-' ? undefined : Number(removed) }
      })
      if (!finding && !assessment.files.length) assessment.blockers.push(t('没有可验收的代码修改。'))
      assessment.diff = (await projectGit(w.path, 'diff', '--no-ext-diff', '--no-textconv', '--stat', base, review.head!)) + '\n' +
        (await projectGit(w.path, 'diff', '--no-ext-diff', '--no-textconv', '--unified=3', base, review.head!)).slice(0, 48_000)
      if (!finding) {
        try { await projectGit(w.root, 'merge-tree', '--write-tree', assessment.targetHead, review.head!) }
        catch (error) {
          const conflict = (error as { code?: number }).code === 1
          assessment.blockers.push(conflict ? t('与当前集成分支存在冲突，请在工作分支解决后重新提交。') : t('无法检查合并状态，请在主对话中核查 Git 环境。'))
        }
      }
      for (const other of this.store.conversations) {
        if (other.id === id || other.projectId !== conv.projectId || other.review?.state !== 'pending' || !other.workspace || !other.review.head) continue
        const changed = await gitText(other.workspace.path, 'diff', '--no-renames', '--name-only', '-z', other.review.base ?? other.workspace.base, other.review.head)
        const files = changed.split('\0').filter((f) => f && assessment.files.includes(f))
        if (files.length) assessment.overlaps.push({ threadId: other.id, title: other.title, files })
      }
    }
    // A user message or resubmission may have arrived during Git I/O.
    const current = this.revision(id, revision).review
    const recommendation = current.recommendation?.targetHead === assessment.targetHead ? current.recommendation : undefined
    const updated = { ...current, assessment, recommendation }
    this.chat.patchConversation(id, { review: updated })
    return updated
  }

  async recommend(id: string, revision: string, verdict: NonNullable<DeliveryReview['recommendation']>['verdict'], notes: string, summary?: string, integrationPlan?: string): Promise<DeliveryReview> {
    if (!notes.trim()) throw new Error(t('请说明验收依据和未验证项。'))
    const conv = this.thread(id)
    const decision = conv.review?.decidedAt
    if (verdict === 'ready' && conv.taskKind === 'change' && conv.review?.kind !== 'finding' && !integrationPlan?.trim()) throw new Error(t('请先由主对话说明合入方式和影响。'))
    const checked = await this.inspect(id, revision)
    if (checked.decidedAt !== decision) throw new Error(t('用户刚提出了新意见，请阅读后重新审核。'))
    const review = { ...checked, recommendation: { verdict, notes: notes.slice(0, 12000), summary: summary?.slice(0, 300), integrationPlan: integrationPlan?.trim().slice(0, 6000), targetHead: checked.assessment?.targetHead, at: Date.now() } }
    this.chat.patchConversation(id, { review })
    return review
  }

  /** A question is not a rejection or a command to restart a worker. */
  async discuss(id: string, revision: string, feedback: string): Promise<void> {
    const c = this.thread(id)
    await this.locked(c.workspace?.root ?? c.projectId!, async () => {
      const { conv, review } = this.revision(id, revision)
      if (!feedback.trim()) throw new Error(t('请填写反馈意见。'))
      if (this.chat.isBusy(id)) throw new Error(t('讨论串仍在工作，请等它结束。'))
      const decidedAt = Math.max(Date.now(), (review.decidedAt ?? 0) + 1)
      this.chat.patchConversation(id, { review: {
        ...review, feedback: feedback.trim(), continuation: 'main', decidedAt, decisionPending: true,
        recommendation: { ...review.recommendation, verdict: 'needs_discussion', notes: review.recommendation?.notes ?? '', summary: t('有新意见，待主对话讨论'), targetHead: review.assessment?.targetHead, at: decidedAt }
      }, resolved: false })
      this.chat.addMessage(this.store.project(conv.projectId)!.conversationId, 'system', [{ type: 'text', text: t('关于「{0}」的意见：{1}', conv.title, feedback.trim()) }])
      this.notifyDecision(id)
    })
  }

  async accept(id: string, revision: string): Promise<void> {
    const { conv } = this.revision(id, revision)
    await this.locked(conv.workspace?.root ?? conv.projectId!, async () => {
      if (this.chat.isBusy(id)) throw new Error(t('讨论串仍在工作，请等它结束。'))
      const review = await this.inspect(id, revision)
      if (!review.recommendation || review.recommendation.verdict !== 'ready') throw new Error(t('请先由主对话完成当前版本的审核。'))
      if (review.kind !== 'finding' && conv.taskKind === 'change' && !review.recommendation.integrationPlan) throw new Error(t('请先由主对话说明合入方式和影响。'))
      if (review.assessment?.blockers.length) throw new Error(review.assessment.blockers.join('\n'))
      if (this.chat.isBusy(id)) throw new Error(t('讨论串仍在工作，请等它结束。'))
      this.revision(id, revision)
      const w = review.kind === 'finding' ? undefined : this.thread(id).workspace
      this.chat.patchConversation(id, { review: { ...review, state: 'merging' } })
      // Persist intent before changing Git. A restart can inspect this instead of repeating a merge blindly.
      this.store.flush()
      let mergeCommit: string | undefined
      try {
        if (w) {
          await projectGit(w.root, 'merge', '--no-ff', '--no-edit', review.head!)
          mergeCommit = await projectGit(w.root, 'rev-parse', 'HEAD')
        }
      } catch (error) {
        this.chat.patchConversation(id, { review: { ...review, state: 'stale', recommendation: undefined } })
        throw error
      }
      this.chat.patchConversation(id, { review: { ...review, state: 'accepted', decidedAt: Date.now(), mergeCommit, decisionPending: true }, ...(w ? { workspace: { ...w, base: review.head! } } : {}), resolved: true, status: 'done' })
      if (w) for (const other of this.store.conversations) {
        if (other.id === id || other.review?.state !== 'pending' || other.workspace?.root !== w.root || other.workspace.targetBranch !== w.targetBranch) continue
        this.chat.patchConversation(other.id, { review: { ...other.review, recommendation: undefined } })
        this.onSubmitted?.(other.projectId!)
      }
      this.chat.addMessage(this.store.project(conv.projectId)!.conversationId, 'system', [{ type: 'text', text: t('已通过「{0}」的验收。', conv.title) + (mergeCommit ? ` ${mergeCommit.slice(0, 8)}` : '') }])
      this.onSubmitted?.(conv.projectId!)
      this.notifyDecision(id)
    })
  }

  async returnForChanges(id: string, revision: string, feedback: string, continuation: 'thread' | 'main' = 'thread'): Promise<void> {
    const { conv, review } = this.revision(id, revision)
    if (!feedback.trim()) throw new Error(t('请填写需要修改的内容。'))
    if (this.chat.isBusy(id)) throw new Error(t('讨论串仍在工作，请等它结束。'))
    this.chat.patchConversation(id, { review: { ...review, state: 'returned', feedback: feedback.trim(), continuation, decisionPending: true, decidedAt: Date.now() }, resolved: false })
    this.chat.addMessage(this.store.project(conv.projectId)!.conversationId, 'system', [{ type: 'text', text: t('已退回「{0}」：{1}', conv.title, feedback.trim()) }])
    this.notifyDecision(id)
    if (continuation === 'thread') void this.chat.send(id, review.kind === 'finding' ? t('用户对分析提出了补充要求，请继续验证并重新提交：\n{0}', feedback.trim()) : t('用户退回本次交付，请修改后重新提交验收：\n{0}', feedback.trim())).catch(() => undefined)
  }

  /** The reviewed blobs, not whatever happens to be in a worker's directory now. */
  async file(id: string, revision: string, path: string): Promise<ReviewFileContent> {
    const conv = this.thread(id)
    const review = conv.review
    if (!review || review.id !== revision || !review.head || !conv.workspace) throw new Error(t('交付版本已变化，请重新查看最新提交。'))
    if (!review.assessment?.files.includes(path)) throw new Error(t('此文件不在当前交付的更改列表中。'))
    const w = conv.workspace
    const base = review.base ?? await projectGit(w.root, 'merge-base', review.head, review.recommendation?.targetHead ?? review.assessment.targetHead ?? w.base)
    const read = async (commit: string) => {
      let size: number
      try { size = Number(await projectGit(w.root, 'cat-file', '-s', `${commit}:${path}`)) } catch { return undefined }
      if (size > 256 * 1024) return { tooBig: true }
      const text = await gitText(w.root, 'show', `${commit}:${path}`)
      return text.includes('\0') ? { binary: true } : { text }
    }
    const [before, after] = await Promise.all([read(base), read(review.head)])
    const binary = !!(before?.binary || after?.binary), tooBig = !!(before?.tooBig || after?.tooBig)
    const patch = binary || tooBig ? '' : await gitText(w.root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=4', base, review.head, '--', path)
    if (this.thread(id).review?.id !== revision) throw new Error(t('交付版本已变化，请重新查看最新提交。'))
    return { path, before: before?.text, after: after?.text, patch, binary, tooBig }
  }
}
