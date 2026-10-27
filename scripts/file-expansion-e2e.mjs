// Expanding a file is a workspace layout, including from a transformed sidebar.
// Real temporary files, hidden Electron and no provider requests.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-file-expand-')))
const root = mkdtempSync(join(tmpdir(), 'fenn-file-expand-work-'))
const outside = join(mkdtempSync(join(tmpdir(), 'fenn-file-expand-outside-')), '只读说明.txt')
writeFileSync(outside, '这是工作目录之外的只读文件。')
const shots = resolve(process.argv[2] ?? '.local/file-expansion')
mkdirSync(shots, { recursive: true })
writeFileSync(join(root, '测试文件.txt'), '这是一个测试文件。\n创建时间：2026-10-26\n用途：确认在当前工作区展开文件。\n' + Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 行 · 用于核对返回后的阅读位置。`).join('\n'))
writeFileSync(join(root, '说明.md'), '# 文件预览\n\n展开后占据主工作区。\n\n' + Array.from({ length: 100 }, (_, i) => `第 ${i + 1} 段，用于核对预览阅读位置。\n`).join('\n'))
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')), now = Date.now()
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0 }
state.projects = [{ id: 'project', name: '文件展开 · 示例项目', cwd: root, backendId: 'mock', conversationId: 'main', createdAt: now, updatedAt: now }]
const conv = (id, title, extra = {}) => ({ id, title, kind: 'chat', cwd: root, backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now, ...extra })
state.conversations = [conv('chat', '文件展开 · 示例对话'), conv('main', '文件展开 · 示例项目', { kind: 'project', projectId: 'project' })]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
mkdirSync(join(data, 'messages'))
writeFileSync(join(data, 'messages', 'chat.json'), JSON.stringify([
  { id: 'u', conversationId: 'chat', role: 'user', createdAt: now, blocks: [{ type: 'text', text: '检查文件展开。' }] },
  { id: 'a', conversationId: 'chat', role: 'assistant', state: 'done', createdAt: now + 1, blocks: [{ type: 'text', text: `[打开文件](${pathToFileURL(join(root, '测试文件.txt')).href}) · [只读文件](${pathToFileURL(outside).href})` }] }
]))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await app.firstWindow({ timeout: 15000 }); page.setDefaultTimeout(8000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor(); await resizeViewport(page, { width: 1360, height: 850 })
  const settle = () => page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))
  })
  const shot = async name => { await page.mouse.move(700, 25); await settle(); await page.screenshot({ path: join(shots, name + '.png') }) }
  const checkBounds = async () => {
    await settle()
    const bounds = await page.evaluate(() => {
      const workspace = document.querySelector('.main > .workspace'), full = document.querySelector('.file-full')
      const a = workspace.getBoundingClientRect(), b = full.getBoundingClientRect()
      return { target: { x: a.x, y: a.y, width: a.width, height: a.height }, actual: { x: b.x, y: b.y, width: b.width, height: b.height }, clipped: !!full.closest('.side-pane,.page-panel,.panel'), overlays: document.querySelectorAll('.overlay').length }
    })
    assert.equal(bounds.clipped, false, 'expanded file remains inside a transformed/clipped side pane: ' + JSON.stringify(bounds))
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(bounds.actual[key] - bounds.target[key]) <= 1, key + ': ' + JSON.stringify(bounds))
    assert.equal(bounds.overlays, 0, 'expansion must not create a dimmed modal')
  }
  await page.locator('.sidebar .nav-item').filter({ hasText: '文件展开 · 示例对话' }).click()
  await page.locator('.side-pane-toggle').click()
  const pane = page.locator('.side-pane .files-pane')
  await pane.locator('.tree-row[data-path="测试文件.txt"]').click()
  const initialEditor = pane.locator('.preview-editor')
  await initialEditor.waitFor()
  await initialEditor.evaluate(el => {
    el.focus(); el.setSelectionRange(70, 78); el.scrollTop = 240
    el.dispatchEvent(new Event('select', { bubbles: true })); el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  const position = await initialEditor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop }))
  await pane.locator('.preview-head').getByRole('button', { name: '全屏', exact: true }).click()
  await page.locator('.file-full').waitFor()
  await shot('expanded-chat-light')
  await checkBounds()
  const expanded = page.locator('.file-full')
  assert.deepEqual(await expanded.locator('.preview-editor').evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop })), position)
  await expanded.locator('.preview-editor').press('Tab')
  assert(await expanded.locator('.preview-editor').evaluate(el => el === document.activeElement && el.value.includes('\t')))
  await expanded.locator('.preview-editor').fill('在展开的工作区中编辑，自动保存。')
  await expanded.locator('.preview-save-state').filter({ hasText: '已保存' }).waitFor()
  assert.equal(readFileSync(join(root, '测试文件.txt'), 'utf8'), '在展开的工作区中编辑，自动保存。')
  await expanded.locator('.preview-head').getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '复制路径', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert(await expanded.isVisible(), 'menu Escape closed the file expansion')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
    for (const width of [1360, 860, 640]) {
      await resizeViewport(page, { width, height: 850 }); await checkBounds()
      if (width === 640) await shot(`expanded-chat-${theme}-narrow`)
    }
  }
  await page.evaluate(() => document.documentElement.style.zoom = '1.25')
  await checkBounds()
  await page.evaluate(() => document.documentElement.style.zoom = '')
  await resizeViewport(page, { width: 1360, height: 850 })
  await page.keyboard.press('Escape'); await expanded.waitFor({ state: 'detached' })
  assert.equal(await pane.locator('.preview-editor').inputValue(), '在展开的工作区中编辑，自动保存。')
  assert(await pane.locator('.preview-head').getByRole('button', { name: '全屏', exact: true }).evaluate(el => el === document.activeElement))
  await pane.locator('.preview-head').getByRole('button', { name: '返回文件列表', exact: true }).click()
  await pane.locator('.tree-row[data-path="说明.md"]').click()
  await pane.locator('.preview-md h1').waitFor()
  await pane.locator('.preview-body').evaluate(el => { el.scrollTop = 480; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await pane.locator('.preview-head').getByRole('button', { name: '全屏', exact: true }).click()
  await checkBounds()
  assert.equal(await expanded.locator('.preview-body').evaluate(el => el.scrollTop), 480)
  await expanded.locator('.preview-body').evaluate(el => { el.scrollTop = 600; el.dispatchEvent(new Event('scroll', { bubbles: true })) })
  await expanded.locator('.preview-head').getByRole('button', { name: '退出全屏', exact: true }).click()
  await expanded.waitFor({ state: 'detached' })
  assert.equal(await pane.locator('.preview-body').evaluate(el => el.scrollTop), 600)
  await page.locator('.recent-projects .nav-item').filter({ hasText: '文件展开 · 示例项目' }).click()
  await page.locator('.panel-head [data-tab=library]').click()
  const library = page.locator('.panel .files-pane')
  await library.locator('.tree-row[data-path="测试文件.txt"]').click()
  await library.locator('.preview-editor').waitFor()
  await library.locator('.preview-head').getByRole('button', { name: '全屏', exact: true }).click()
  await checkBounds(); await shot('expanded-project-dark')
  for (const width of [860, 640]) { await resizeViewport(page, { width, height: 850 }); await checkBounds() }
  await page.keyboard.press('Escape'); await expanded.waitFor({ state: 'detached' })
  assert(await library.locator('.preview-editor').isVisible())
  await resizeViewport(page, { width: 1360, height: 850 })
  await page.locator('.sidebar .nav-item').filter({ hasText: '文件展开 · 示例对话' }).click()
  await page.locator('.md').getByRole('link', { name: '打开文件', exact: true }).click()
  const linked = page.locator('.file-view')
  await linked.locator('.preview-editor').waitFor()
  await linked.locator('.preview-head').getByRole('button', { name: '全屏', exact: true }).click()
  await checkBounds()
  assert(await page.locator('.main > .workspace > .center').evaluate(el => el.inert))
  await page.keyboard.press('Escape'); await expanded.waitFor({ state: 'detached' })
  await linked.locator('.preview-head').getByRole('button', { name: '关闭', exact: true }).click()
  await linked.waitFor({ state: 'detached' })
  await page.locator('.md').getByRole('link', { name: '只读文件', exact: true }).click()
  await linked.locator('.preview-code').waitFor()
  await linked.locator('.preview-head').getByRole('button', { name: '全屏', exact: true }).click()
  await checkBounds()
  assert.equal(await expanded.locator('.preview-editor').count(), 0)
  assert(await expanded.evaluate(el => el.contains(document.activeElement)))
  await page.keyboard.press('Escape'); await expanded.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.main > .workspace > .center').evaluate(el => el.inert), false)
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log(JSON.stringify({ passed: true, checks: 'workspace bounds, no clipping/backdrop, text/Markdown, caret/selection/scroll retention, autosave, Tab, menus, focus/inert restoration, project/chat/link/read-only entry points, both themes, 3 widths and zoom', shots, hidden: true }))
} finally { await app.close() }
