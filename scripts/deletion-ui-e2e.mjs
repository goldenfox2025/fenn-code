// Hidden UI acceptance. Trash is a fixture-only move, confined to one temp root.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const base = mkdtempSync(join(tmpdir(), 'fenn-deletion-ui-')), data = declareTestAgent(join(base, 'data'))
const shots = resolve(process.argv[2] ?? '.local/deletion-ui')
mkdirSync(shots, { recursive: true })
const root = name => { const path = join(base, name); mkdirSync(path); writeFileSync(join(path, 'notes.txt'), name); return path }
const paths = Object.fromEntries(['auto', 'manual', 'manual-trash', 'shared', 'batch', 'failure', 'stale', 'other', 'project', 'worktree'].map(name => [name, root(name)]))
const now = Date.now(), state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0, autoFolderRoot: join(base, 'automatic') }
const chat = (id, path, autoFolder = false) => ({ id, title: id, kind: 'chat', cwd: path, autoFolder: autoFolder || undefined, backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now })
state.conversations = [chat('自动目录', paths.auto, true), chat('保留手选目录', paths.manual), chat('回收手选目录', paths['manual-trash']), chat('共享甲', paths.shared, true), chat('共享乙', paths.shared), chat('批量甲', paths.batch, true), chat('批量乙', paths.batch), chat('失败保留', paths.failure, true), chat('范围更新', paths.stale, true), chat('其他引用', paths.other)]
state.projects = [{ id: 'project', name: '删除项目', cwd: paths.project, autoFolder: true, backendId: 'mock', conversationId: 'main', createdAt: now, updatedAt: now }]
state.conversations.push({ ...chat('main', paths.project), title: '删除项目', kind: 'project', projectId: 'project' })
state.conversations.push({ ...chat('worker', paths.worktree), title: '独立工作区', kind: 'thread', projectId: 'project', workspace: { root: paths.project, path: paths.worktree, branch: 'fixture', targetBranch: 'main', base: 'fixture' } })
for (let i = 0; i < 20; i++) state.conversations.push(chat('批量多项-' + i, root('many-' + i), true))
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  await app.evaluate(({ shell }, base) => {
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path')
    globalThis.__deletionFixture = { moved: [], fail: false }
    const trash = path.join(base, 'trash'); fs.mkdirSync(trash)
    shell.trashItem = async from => {
      if (!path.resolve(from).startsWith(path.resolve(base) + path.sep)) throw Error('Outside fixture root')
      if (globalThis.__deletionFixture.fail) throw Error('Fixture trash unavailable')
      const to = path.join(trash, globalThis.__deletionFixture.moved.length + '-' + path.basename(from))
      fs.renameSync(from, to); globalThis.__deletionFixture.moved.push({ from, to })
    }
  }, base)
  const page = await app.firstWindow(); page.setDefaultTimeout(8000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor(); await page.waitForLoadState('networkidle')
  await resizeViewport(page, { width: 1440, height: 900 })
  const modal = page.locator('.deletion-confirm')
  const snapshot = () => page.evaluate(() => window.fenn.snapshot())
  const sidebarDelete = async title => {
    const row = page.locator('.sidebar .nav-item').filter({ hasText: title }).first()
    await row.click({ button: 'right' })
    await page.locator('.menu .menu-item').filter({ hasText: '删除' }).click()
    await modal.waitFor()
  }
  const submit = async () => { await modal.getByRole('button', { name: '删除', exact: true }).click(); await modal.waitFor({ state: 'detached' }) }
  const shot = async name => {
    await page.mouse.move(300, 25)
    await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
    await page.screenshot({ path: join(shots, name + '.png') })
    const overflow = await modal.evaluate(el => el.scrollWidth - el.clientWidth)
    assert(overflow <= 1)
  }
  await sidebarDelete('自动目录')
  assert(await modal.getByRole('checkbox').isChecked())
  assert((await modal.innerText()).includes(paths.auto))
  assert(await modal.getByRole('button', { name: '取消', exact: true }).evaluate(el => el === document.activeElement))
  await shot('automatic-light')
  await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' })
  assert(existsSync(paths.auto)); assert((await snapshot()).conversations.some(c => c.id === '自动目录'))
  await sidebarDelete('自动目录'); await submit()
  assert(!existsSync(paths.auto)); assert(!(await snapshot()).conversations.some(c => c.id === '自动目录'))
  await sidebarDelete('保留手选目录'); assert(!await modal.getByRole('checkbox').isChecked()); await submit()
  assert(existsSync(paths.manual))
  await sidebarDelete('回收手选目录'); await modal.getByRole('checkbox').check(); await submit()
  assert(!existsSync(paths['manual-trash']))
  await sidebarDelete('共享甲'); assert(await modal.getByRole('checkbox').isDisabled())
  assert((await modal.innerText()).includes('仍被其他对话或项目使用'))
  await shot('shared-light'); await submit()
  assert(existsSync(paths.shared)); assert((await snapshot()).conversations.some(c => c.id === '共享乙'))
  await sidebarDelete('范围更新')
  await page.evaluate(path => window.fenn.updateConversation('其他引用', { cwd: path }), paths.stale)
  await modal.getByRole('button', { name: '删除', exact: true }).click()
  await modal.getByRole('alert').filter({ hasText: '删除范围发生变化' }).waitFor()
  await page.waitForFunction(() => document.querySelector('.deletion-confirm input[type=checkbox]')?.disabled)
  assert(existsSync(paths.stale)); assert((await snapshot()).conversations.some(c => c.id === '范围更新'))
  await submit(); assert(existsSync(paths.stale))
  await app.evaluate(() => { globalThis.__deletionFixture.fail = true })
  await sidebarDelete('失败保留'); await modal.getByRole('button', { name: '删除', exact: true }).click()
  await modal.getByRole('alert').filter({ hasText: '删除记录的操作尚未执行' }).waitFor()
  assert(existsSync(paths.failure)); assert((await snapshot()).conversations.some(c => c.id === '失败保留'))
  await shot('trash-failure')
  await app.evaluate(() => { globalThis.__deletionFixture.fail = false })
  await submit(); assert(!existsSync(paths.failure))
  await page.evaluate(() => window.fenn.updateSettings({ theme: 'dark' }))
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  await sidebarDelete('删除项目')
  assert.equal(await modal.getByRole('checkbox').count(), 2)
  const repository = modal.locator('.deletion-folder').filter({ hasText: paths.project }).getByRole('checkbox')
  const checkout = modal.locator('.deletion-folder').filter({ hasText: paths.worktree }).getByRole('checkbox')
  assert(await repository.isChecked()); assert(await checkout.isChecked())
  await checkout.uncheck(); assert(!await repository.isChecked())
  await repository.check(); assert(await checkout.isChecked())
  await resizeViewport(page, { width: 680, height: 640 }); await shot('project-dark-narrow')
  await submit(); assert(!existsSync(paths.project)); assert(!(await snapshot()).projects.some(p => p.id === 'project'))
  await resizeViewport(page, { width: 1440, height: 900 })
  await page.locator('.sidebar .nav-item').filter({ hasText: /^对话$/ }).click()
  await page.locator('.page-head').getByRole('button', { name: '选择', exact: true }).click()
  for (const title of ['批量甲', '批量乙']) await page.getByRole('checkbox').filter({ hasText: title }).click()
  await page.locator('.select-bar').getByRole('button', { name: '删除', exact: true }).click()
  await modal.waitFor(); assert.equal(await modal.getByRole('checkbox').count(), 1)
  assert(await modal.getByRole('checkbox').isChecked()); await shot('batch-dark'); await submit()
  assert(!existsSync(paths.batch))
  await page.locator('input[placeholder="搜索对话…"]').fill('批量多项-')
  await page.locator('.page-head').getByRole('button', { name: '选择', exact: true }).click()
  await page.locator('.select-bar').getByRole('button', { name: '全选', exact: true }).click()
  await page.locator('.select-bar').getByRole('button', { name: '删除', exact: true }).click()
  await modal.waitFor(); assert.equal(await modal.getByRole('checkbox').count(), 20)
  const bounds = await modal.evaluate(el => {
    const body = el.querySelector('.deletion-body'), buttons = el.querySelector('.modal-actions').getBoundingClientRect(), r = el.getBoundingClientRect()
    return { scrolls: body.scrollHeight > body.clientHeight, bottom: buttons.bottom, viewport: innerHeight, modalBottom: r.bottom }
  })
  assert(bounds.scrolls); assert(bounds.bottom < bounds.viewport && bounds.modalBottom < bounds.viewport)
  await shot('many-folders-dark'); await page.keyboard.press('Escape'); await modal.waitFor({ state: 'detached' })
  assert.equal((await snapshot()).conversations.filter(c => c.id.startsWith('批量多项-')).length, 20)
  await page.evaluate(() => window.fenn.updateSettings({ language: 'en' }))
  await page.waitForFunction(() => document.documentElement.lang.startsWith('en'))
  await page.locator('.sidebar .nav-item').filter({ hasText: '共享乙' }).first().click({ button: 'right' })
  await page.locator('.menu .menu-item').filter({ hasText: 'Delete' }).click()
  await modal.waitFor(); assert(!await modal.getByRole('checkbox').isChecked())
  await resizeViewport(page, { width: 680, height: 640 }); await shot('manual-english-narrow')
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click(); await modal.waitFor({ state: 'detached' })
  const moved = await app.evaluate(() => globalThis.__deletionFixture.moved)
  assert.equal(moved.filter(item => item.from === paths.batch).length, 1)
  for (const item of moved) assert.equal(readFileSync(join(item.to, 'notes.txt'), 'utf8'), item.from.split(/[\\/]/).at(-1))
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log(JSON.stringify({ passed: true, checks: ['automatic checked, chosen unchecked, optional chosen trash', 'cancel and keyboard focus', 'shared folder protected', 'stale reference rechecked', 'trash failure retains records and retries', 'project and bulk deletion use the same flow', 'worktree/common-directory selection dependencies', '20 folders scroll while decision buttons stay visible', 'Chinese/English, light/dark and narrow layout', 'all trashed fixture files recoverable'], shots, hidden: true }, null, 2))
} catch (error) {
  await app.windows()[0]?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
