import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { projectGit } from '../src/main/core/ProjectReviews'
import { makeCore, until } from './helpers'

const disposals: (() => Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose() })

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fenn-review-repo-'))
  await projectGit(root, 'init', '-b', 'main')
  await projectGit(root, 'config', 'user.name', 'Fenn test')
  await projectGit(root, 'config', 'user.email', 'fixture@example.invalid')
  await projectGit(root, 'config', 'commit.gpgsign', 'false')
  await projectGit(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'shared.txt'), 'base\n')
  await projectGit(root, 'add', '.')
  await projectGit(root, 'commit', '-m', 'base')
  const harness = await makeCore()
  disposals.push(harness.dispose)
  const { core } = harness
  const project = await core.createProject({ name: 'Parallel review fixture', backendId: 'mock', cwd: root })
  const worker = () => core.chat.createConversation({ kind: 'thread', title: 'worker', projectId: project.id, backendId: 'mock', cwd: root, isolateWorkspace: true })
  const reviews = core.orchestrator.reviews
  const wakeCoordinator = reviews.onSubmitted
  reviews.onSubmitted = undefined
  reviews.onDecided = undefined
  const a = worker(), b = worker()
  await Promise.all([reviews.prepare(a), reviews.prepare(b)])
  return { ...harness, root, project, reviews, wakeCoordinator, a: harness.store.requireConversation(a.id), b: harness.store.requireConversation(b.id) }
}

async function commit(path: string, file: string, body: string) {
  writeFileSync(join(path, file), body)
  await projectGit(path, 'add', '--', file)
  await projectGit(path, 'commit', '-m', `update ${file}`)
}

describe('project deliveries use real isolated Git worktrees', { timeout: 60_000 }, () => {
  it.skipIf(process.env.FENN_REAL_REVIEW !== '1')('real Codex reviews concurrent diffs and catches a false passing-test claim', async () => {
    const { core, reviews, a, b, store, project, root } = await fixture()
    reviews.onSubmitted = undefined
    const adapter = process.env.FENN_CODEX_ACP
    const cli = process.env.FENN_CODEX_CLI
    if (!adapter || !cli) throw new Error('Set FENN_CODEX_ACP and FENN_CODEX_CLI to installed paths')
    await core.setBackendSetting('codex', 'CODEX_ACP_PATH', adapter)
    await core.setBackendSetting('codex', 'CODEX_CLI_PATH', cli)
    await core.updateConversation(project.conversationId, { backendId: 'codex' })
    await core.updateConversation(a.id, { backendId: 'codex', title: '额度归零 · 交付 A' })
    await core.updateConversation(b.id, { backendId: 'codex', title: '额度归零 · 交付 B' })
    await core.updateProject(project.id, { name: '额度计算 · 并行审核试验', backendId: 'codex', description: '隔离试验：两份交付修改同一行，其中一份包含故意放入的计算错误和错误的测试声明。等待主对话独立审核，由用户最终验收。', instructions: '验收要求：remaining(total, used) 必须返回 max(0, total-used)。工作者测试声明可能不可靠，必须核对真实 diff；可以在各自工作目录运行 node --test。禁止网络和外部项目写入。' })
    writeFileSync(join(root, 'credits.mjs'), 'export const remaining = (total, used) => total - used;\n')
    writeFileSync(join(root, 'credits.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {remaining} from './credits.mjs'; test('remaining',()=>assert.equal(remaining(100,30),70)); test('clamp',()=>assert.equal(remaining(10,30),0));\n")
    await projectGit(root, 'add', '.')
    await projectGit(root, 'commit', '-m', 'credit accounting requirements')
    // Advance both fixture branches to the exact same baseline before creating two different deliveries.
    for (const c of [a, b]) {
      await projectGit(c.cwd!, 'merge', '--ff-only', 'main')
      core.chat.patchConversation(c.id, { workspace: { ...c.workspace!, base: await projectGit(c.cwd!, 'rev-parse', 'HEAD') } })
    }
    await Promise.all([
      commit(a.cwd!, 'credits.mjs', 'export const remaining = (total, used) => Math.max(0, total + used);\n'),
      commit(b.cwd!, 'credits.mjs', 'export const remaining = (total, used) => Math.max(0, total - used);\n')
    ])
    const [bad, good] = await Promise.all([
      reviews.submit(a.id, 'Add nonnegative remaining credits', 'node --test: all tests passed'),
      reviews.submit(b.id, 'Clamp remaining credits to zero', 'No independent test evidence supplied')
    ])
    store.flush()
    console.log('REAL_REVIEW_PROFILE', store.dir)
    await core.chat.send(project.conversationId, `请验收两个并行交付：${a.id} revision:${bad.id}；${b.id} revision:${good.id}。需要辨别交付的真实正确性，不相信自报通过。分别 inspect_delivery 并 review_delivery，说明文件碰撞风险。不要修改文件或合并。`)
    console.log('REAL_REVIEW_RESULT', JSON.stringify([store.requireConversation(a.id).review, store.requireConversation(b.id).review].map((r) => ({ id: r?.id, state: r?.state, overlaps: r?.assessment?.overlaps, recommendation: r?.recommendation }))))
    expect(store.requireConversation(a.id).review?.recommendation?.verdict).toBe('changes_requested')
    expect(store.requireConversation(a.id).review?.assessment?.overlaps[0]?.files).toContain('credits.mjs')
    expect(store.requireConversation(a.id).review?.state).toBe('pending')
    expect(store.requireConversation(b.id).review?.recommendation).toBeDefined()
  }, 240_000)

  it('isolates parallel workers; user acceptance merges only the reviewed version and forces review after target advances', async () => {
    const { root, reviews, a, b, store, core } = await fixture()
    expect(a.cwd).not.toBe(b.cwd)
    expect(a.cwd).not.toBe(root)
    await Promise.all([commit(a.cwd!, 'a.txt', 'A'), commit(b.cwd!, 'b.txt', 'B')])
    const [ra, rb] = await Promise.all([reviews.submit(a.id, 'A', 'worker: checked'), reviews.submit(b.id, 'B')])
    expect(ra.assessment?.files).toEqual(['a.txt'])
    expect(ra.assessment?.overlaps).toEqual([])
    expect(store.requireConversation(a.id).resolved).toBe(false)
    await expect(reviews.accept(a.id, ra.id)).rejects.toThrow('审核')
    await expect(core.updateConversation(a.id, { resolved: true })).rejects.toThrow('验收')
    await reviews.recommend(a.id, ra.id, 'ready', 'Fixture reviewer checks the exact diff')
    await reviews.recommend(b.id, rb.id, 'ready', 'Fixture reviewer checks the exact diff')
    await reviews.accept(a.id, ra.id)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A')
    expect(store.requireConversation(a.id).review?.state).toBe('accepted')
    await expect(reviews.accept(b.id, rb.id)).rejects.toThrow('审核')
    await reviews.recommend(b.id, rb.id, 'ready', 'Rechecked against new integration head')
    await reviews.accept(b.id, rb.id)
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('B')
  })

  it('reports overlapping edits before merge, detects actual collision after first acceptance, and keeps failed changes out', async () => {
    const { root, reviews, a, b, store } = await fixture()
    await Promise.all([commit(a.cwd!, 'shared.txt', 'A\n'), commit(b.cwd!, 'shared.txt', 'B\n')])
    const [ra, rb] = await Promise.all([reviews.submit(a.id, 'A'), reviews.submit(b.id, 'B', 'FAIL: expected A, got B')])
    const checked = await reviews.inspect(b.id, rb.id)
    expect(checked.assessment?.overlaps[0]).toMatchObject({ threadId: a.id, files: ['shared.txt'] })
    await reviews.recommend(b.id, rb.id, 'changes_requested', 'Reported test fails; do not integrate')
    await expect(reviews.accept(b.id, rb.id)).rejects.toThrow('审核')
    await reviews.recommend(a.id, ra.id, 'ready', 'Checked fixture A')
    await reviews.accept(a.id, ra.id)
    const blocked = await reviews.inspect(b.id, rb.id)
    expect(blocked.assessment?.blockers.join()).toContain('冲突')
    await reviews.recommend(b.id, rb.id, 'ready', 'Even an incorrect recommendation must not bypass a real conflict')
    await expect(reviews.accept(b.id, rb.id)).rejects.toThrow('冲突')
    expect(await projectGit(root, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('A\n')
    expect(store.requireConversation(b.id).resolved).toBe(false)
  })

  it('rejects stale commits and dirty delivery / integration checkouts', async () => {
    const { reviews, a, root, store } = await fixture()
    await commit(a.cwd!, 'new.txt', 'v1')
    const r = await reviews.submit(a.id, 'v1')
    await reviews.recommend(a.id, r.id, 'ready', 'checked v1')
    writeFileSync(join(root, 'local.txt'), 'user changes')
    await expect(reviews.accept(a.id, r.id)).rejects.toThrow('未提交')
    expect(readFileSync(join(root, 'local.txt'), 'utf8')).toBe('user changes')
    await commit(a.cwd!, 'new.txt', 'v2')
    await expect(reviews.accept(a.id, r.id)).rejects.toThrow('重新提交')
    expect(store.requireConversation(a.id).review?.state).toBe('stale')
    const r2 = await reviews.submit(a.id, 'v2')
    writeFileSync(join(a.cwd!, 'untracked.txt'), 'not reviewed')
    expect((await reviews.inspect(a.id, r2.id)).assessment?.blockers.join()).toContain('工作区有未提交')
    await expect(reviews.returnForChanges(a.id, r.id, 'old revision')).rejects.toThrow('版本已变化')
  })

  it('routes rejection to the original thread; resubmission invalidates the old revision', async () => {
    const { core, store, reviews, a } = await fixture()
    await commit(a.cwd!, 'task.txt', 'first attempt')
    const first = await reviews.submit(a.id, 'first attempt')
    await reviews.returnForChanges(a.id, first.id, 'Fix the edge case')
    await until(() => store.messagesOf(a.id).some((m) => JSON.stringify(m.blocks).includes('Fix the edge case')))
    await until(() => !core.chat.isBusy(a.id))
    expect(store.requireConversation(a.id).review?.state).toBe('returned')
    await commit(a.cwd!, 'task.txt', 'second attempt')
    const next = await reviews.submit(a.id, 'second attempt')
    expect(next.id).not.toBe(first.id)
    await expect(reviews.accept(a.id, first.id)).rejects.toThrow('版本已变化')
  }, 30_000)

  it('wakes the coordinator and exposes failed evidence without approving on the user’s behalf', async () => {
    const { core, reviews, a, store, project, wakeCoordinator } = await fixture()
    reviews.onSubmitted = wakeCoordinator
    await commit(a.cwd!, 'broken.txt', 'bad implementation')
    const review = await reviews.submit(a.id, 'A deliberately failing delivery', 'FAIL: 1 test failed')
    reviews.notify(a.id)
    await until(() => store.requireConversation(a.id).review?.recommendation)
    expect(store.requireConversation(a.id).review?.recommendation?.verdict).toBe('changes_requested')
    expect(store.requireConversation(a.id).review?.state).toBe('pending')
    expect(store.messagesOf(project.conversationId).some((m) => m.role === 'user' && m.hidden)).toBe(true)
    await expect(reviews.accept(a.id, review.id)).rejects.toThrow('审核')
    await until(() => !core.chat.isBusy(project.conversationId))
  }, 30_000)

  it('serializes simultaneous approvals and resumes accepted workers from the integrated branch', async () => {
    const { core, store, reviews, a, b, root } = await fixture()
    await Promise.all([commit(a.cwd!, 'one.txt', 'one'), commit(b.cwd!, 'two.txt', 'two')])
    const [ra, rb] = await Promise.all([reviews.submit(a.id, 'one'), reviews.submit(b.id, 'two')])
    await Promise.all([reviews.recommend(a.id, ra.id, 'ready', 'checked one'), reviews.recommend(b.id, rb.id, 'ready', 'checked two')])
    const result = await Promise.allSettled([reviews.accept(a.id, ra.id), reviews.accept(b.id, rb.id)])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const accepted = [a, b].find((c) => store.requireConversation(c.id).review?.state === 'accepted')!
    const remaining = accepted.id === a.id ? b : a
    const revision = store.requireConversation(remaining.id).review!.id
    await reviews.recommend(remaining.id, revision, 'ready', 'reviewed after integration moved')
    await reviews.accept(remaining.id, revision)
    await core.chat.send(accepted.id, 'Continue in the current integrated checkout')
    expect(await projectGit(accepted.cwd!, 'rev-parse', 'HEAD')).toBe(await projectGit(root, 'rev-parse', 'HEAD'))
    expect(store.requireConversation(accepted.id).workspace?.base).toBe(await projectGit(root, 'rev-parse', 'HEAD'))
    expect(store.requireConversation(accepted.id).review?.state).toBe('stale')
  }, 30_000)

  it('recovers an interrupted acceptance from Git without repeating the merge', async () => {
    const { core, store, reviews, a, root, dir, dispose } = await fixture()
    await commit(a.cwd!, 'recovery.txt', 'durable')
    const review = await reviews.submit(a.id, 'recoverable delivery')
    core.chat.patchConversation(a.id, { review: { ...review, state: 'merging' } })
    await projectGit(root, 'merge', '--no-ff', '--no-edit', review.head!)
    const integrated = await projectGit(root, 'rev-parse', 'HEAD')
    store.flush()
    await dispose()
    const restarted = await makeCore(dir)
    disposals.push(restarted.dispose)
    await until(() => restarted.store.requireConversation(a.id).review?.state === 'accepted')
    expect(await projectGit(root, 'rev-parse', 'HEAD')).toBe(integrated)
    expect(restarted.store.requireConversation(a.id).resolved).toBe(true)
  })

  it('opens pinned source and per-file changes, including after acceptance, without reading outside the delivery', async () => {
    const { reviews, a } = await fixture()
    const original = '  export const answer = 42;\n\n'
    await commit(a.cwd!, 'source.mjs', original)
    const review = await reviews.submit(a.id, 'Add source')
    expect(review.assessment?.changes).toEqual([{ path: 'source.mjs', status: 'added', added: 2, removed: 0 }])
    const file = await reviews.file(a.id, review.id, 'source.mjs')
    expect(file.before).toBeUndefined()
    expect(file.after).toBe(original)
    await expect(reviews.file(a.id, review.id, '../state.json')).rejects.toThrow('更改列表')
    await reviews.recommend(a.id, review.id, 'ready', 'Pinned source checked')
    await reviews.accept(a.id, review.id)
    writeFileSync(join(a.cwd!, 'source.mjs'), 'unreviewed local edit')
    expect((await reviews.file(a.id, review.id, 'source.mjs')).after).toBe(original)
  })

  it('accepts an investigation without merging experimental code or requiring code changes', async () => {
    const { reviews, a, root, store } = await fixture()
    const before = await projectGit(root, 'rev-parse', 'HEAD')
    const initial = await reviews.submit(a.id, 'Evidence rules out the layout hypothesis', 'Measured layout sizes', 'Needs another reproduction', 'finding')
    expect(initial.assessment?.blockers).toEqual([])
    await reviews.recommend(a.id, initial.id, 'ready', 'Evidence supports this limited conclusion', '采纳这个排除结论，继续检查焦点变化。')
    await reviews.accept(a.id, initial.id)
    expect(await projectGit(root, 'rev-parse', 'HEAD')).toBe(before)
    await commit(a.cwd!, 'experiment.txt', 'Do not integrate this experiment')
    const experiment = await reviews.submit(a.id, 'Experimental evidence', 'Reproduction collected', '', 'finding')
    await reviews.recommend(a.id, experiment.id, 'ready', 'The experiment supports the finding, not a production change')
    await reviews.accept(a.id, experiment.id)
    expect(await projectGit(root, 'rev-parse', 'HEAD')).toBe(before)
    expect(store.requireConversation(a.id).review?.mergeCommit).toBeUndefined()
  })

  it('handles binary and large files without presenting corrupt source', async () => {
    const { reviews, a } = await fixture()
    await commit(a.cwd!, 'blob.dat', '\0binary\0')
    await commit(a.cwd!, 'large.txt', 'x'.repeat(300_000))
    const r = await reviews.submit(a.id, 'Binary and large file fixture')
    expect((await reviews.file(a.id, r.id, 'blob.dat')).binary).toBe(true)
    expect((await reviews.file(a.id, r.id, 'large.txt')).tooBig).toBe(true)
  })
})
