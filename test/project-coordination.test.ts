import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCore, until } from './helpers'
import { projectGit } from '../src/main/core/ProjectReviews'

async function repository() {
  const root = mkdtempSync(join(tmpdir(), 'fenn-context-'))
  await projectGit(root, 'init', '-b', 'main')
  await projectGit(root, 'config', 'user.name', 'Fenn fixture')
  await projectGit(root, 'config', 'user.email', 'fixture@example.invalid')
  await projectGit(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'base.txt'), 'base')
  await projectGit(root, 'add', '.')
  await projectGit(root, 'commit', '-m', 'baseline')
  return root
}

describe('project ownership and decision handoff', { timeout: 60_000 }, () => {
  it('research threads keep project context and only code threads get their own checkout', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const root = await repository()
      const p = await core.createProject({ name: 'Project', cwd: root, backendId: 'mock' })
      const finding = core.orchestrator.startThread(p, 'Research', 'Inspect the existing evidence')
      await until(() => store.requireConversation(finding.id).status !== 'working' && store.requireConversation(finding.id).sessionRef)
      expect(store.requireConversation(finding.id)).toMatchObject({ projectId: p.id, cwd: root, taskKind: 'finding', isolateWorkspace: false })
      expect(store.requireConversation(finding.id).workspace).toBeUndefined()
      const code = core.orchestrator.startThread(p, 'Code', 'Check a code change', undefined, undefined, 'change')
      await until(() => store.requireConversation(code.id).workspace)
      expect(store.requireConversation(code.id).workspace?.root.replaceAll('\\', '/')).toBe(root.replaceAll('\\', '/'))
      expect(store.requireConversation(code.id).cwd).not.toBe(root)
      expect(store.requireConversation(code.id).projectId).toBe(p.id)
    } finally { await dispose() }
  })

  it('requires an integration plan for a new code task and hands an approved outcome to the coordinator', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const root = await repository()
      const p = await core.createProject({ name: 'Project', cwd: root, backendId: 'mock' })
      const c = core.chat.createConversation({ kind: 'thread', title: 'Change', projectId: p.id, cwd: root, backendId: 'mock', taskKind: 'change', isolateWorkspace: true })
      await core.orchestrator.reviews.prepare(c)
      const cwd = store.requireConversation(c.id).cwd!
      writeFileSync(join(cwd, 'change.txt'), 'change')
      await projectGit(cwd, 'add', '.')
      await projectGit(cwd, 'commit', '-m', 'change')
      const r = await core.orchestrator.reviews.submit(c.id, 'Change', 'Fixture', '', 'change')
      await expect(core.orchestrator.reviews.recommend(c.id, r.id, 'ready', 'The patch matches the requirement')).rejects.toThrow('合入方式')
      await core.orchestrator.reviews.recommend(c.id, r.id, 'ready', 'The patch matches the requirement', 'Ready', 'Merge this revision, run checks, revert this merge if they fail.')
      await core.acceptDelivery(c.id, r.id)
      expect(store.requireConversation(c.id).review?.mergeCommit).toBeTruthy()
      await until(() => store.messagesOf(p.conversationId).some((m) => m.role === 'user' && m.hidden && m.blocks.some((b) => b.type === 'text' && b.text.includes('用户已作出验收决定'))))
      await until(() => !store.requireConversation(c.id).review?.decisionPending)
      expect(store.messagesOf(p.conversationId).some((m) => m.role === 'assistant' && !m.hidden)).toBe(true)
    } finally { await dispose() }
  })

  it('continues in the same thread with a new session when an investigation needs code changes', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const root = await repository()
      const p = await core.createProject({ name: 'Project', cwd: root, backendId: 'mock' })
      const baseline = await projectGit(root, 'rev-parse', 'HEAD')
      const c = core.orchestrator.startThread(p, 'Investigate then fix', '#request-code-workspace')
      await until(() => store.requireConversation(c.id).workspace && store.requireConversation(c.id).status !== 'working')
      expect(store.requireConversation(c.id)).toMatchObject({ projectId: p.id, taskKind: 'change', isolateWorkspace: true })
      expect(store.requireConversation(c.id).cwd).not.toBe(root)
      expect(store.conversations.filter((x) => x.kind === 'thread' && x.projectId === p.id)).toHaveLength(1)
      expect(await projectGit(root, 'rev-parse', 'HEAD')).toBe(baseline)
    } finally { await dispose() }
  })

  it('can return a finding to the main chat without silently starting the worker again', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'Investigation', backendId: 'mock' })
      const c = core.chat.createConversation({ kind: 'thread', title: 'Hypothesis', projectId: p.id, backendId: 'mock', taskKind: 'finding' })
      const r = await core.orchestrator.reviews.submit(c.id, 'Hypothesis not yet confirmed', '', '', 'finding')
      await core.returnDelivery(c.id, r.id, 'Discuss the assumptions before choosing another direction', 'main')
      expect(store.requireConversation(c.id).review).toMatchObject({ state: 'returned', continuation: 'main' })
      expect(store.messagesOf(c.id)).toHaveLength(0)
      await until(() => store.messagesOf(p.conversationId).some((m) => m.role === 'user' && m.hidden && m.blocks.some((b) => b.type === 'text' && b.text.includes('"continuation":"main"'))))
      expect(store.messagesOf(c.id)).toHaveLength(0)
    } finally { await dispose() }
  })

  it('comments await coordinator discussion without rejecting, merging or restarting the worker; later approval stays an approval', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: 'Discussion', backendId: 'mock' })
      const c = core.chat.createConversation({ kind: 'thread', title: 'Finding', projectId: p.id, backendId: 'mock', taskKind: 'finding' })
      const reviews = core.orchestrator.reviews
      reviews.onSubmitted = undefined; reviews.onDecided = undefined
      const r = await reviews.submit(c.id, 'Evidence', '', '', 'finding')
      await reviews.recommend(c.id, r.id, 'ready', 'Initial checked analysis')
      await core.discussDelivery(c.id, r.id, 'Does this match the original scope?')
      expect(store.requireConversation(c.id).review).toMatchObject({ state: 'pending', feedback: 'Does this match the original scope?', recommendation: { verdict: 'needs_discussion', notes: 'Initial checked analysis' } })
      await expect(core.acceptDelivery(c.id, r.id)).rejects.toThrow('审核')
      expect(store.messagesOf(c.id)).toHaveLength(0)
      expect(store.project(p.id)?.pendingReviewDecisions?.[0].decision).toBe('discussion')
      await reviews.recommend(c.id, r.id, 'ready', 'Scope was explained and the evidence still holds')
      await core.acceptDelivery(c.id, r.id)
      expect(store.project(p.id)?.pendingReviewDecisions?.at(-1)?.decision).toBe('accepted')
      expect(store.requireConversation(c.id).review?.mergeCommit).toBeUndefined()
    } finally { await dispose() }
  })

  it('keeps a decision through a failed coordinator turn, a new submission and an app restart', async () => {
    const first = await makeCore(undefined, { MOCK_EXIT_AT_START: '1' })
    const p = await first.core.createProject({ name: 'Durable handoff', backendId: 'mock' })
    const c = first.core.chat.createConversation({ kind: 'thread', title: 'Evidence', projectId: p.id, backendId: 'mock', taskKind: 'finding' })
    const r = await first.core.orchestrator.reviews.submit(c.id, 'Original evidence', '', '', 'finding')
    await first.core.returnDelivery(c.id, r.id, 'Discuss the evidence in the main chat', 'main')
    await until(() => first.store.requireConversation(p.conversationId).status === 'error')
    expect(first.store.project(p.id)?.pendingReviewDecisions).toHaveLength(1)
    const newer = await first.core.orchestrator.reviews.submit(c.id, 'More evidence', '', '', 'finding')
    expect(first.store.project(p.id)?.pendingReviewDecisions?.[0].revision).toBe(r.id)
    await first.dispose()
    const second = await makeCore(first.dir)
    try {
      await until(() => !second.store.project(p.id)?.pendingReviewDecisions?.length)
      expect(second.store.requireConversation(c.id).review?.id).toBe(newer.id)
      expect(second.store.messagesOf(p.conversationId).some((m) => m.role === 'assistant' && !m.hidden && m.state === 'done')).toBe(true)
    } finally { await second.dispose() }
  })
})
