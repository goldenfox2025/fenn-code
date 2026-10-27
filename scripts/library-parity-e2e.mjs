// Compare the actual default, reading and expanded states through both entry points.
// Real temporary files, hidden windows, no provider requests.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-library-parity-')))
const root = join(mkdtempSync(join(tmpdir(), 'fenn-library-work-')), '文件示例')
const shots = resolve(process.argv[2] ?? '.local/library-parity')
mkdirSync(root); mkdirSync(shots, { recursive: true })
const text = '同一个文件，在普通对话和项目中使用相同的浏览与编辑界面。\n' + Array.from({ length: 70 }, (_, i) => `第 ${i + 1} 行，核对编辑位置和返回状态。`).join('\n')
writeFileSync(join(root, '测试'), text)
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')), now = Date.now()
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'dark', dotGrid: 0 }
state.projects = [{ id: 'project', name: '项目文件', cwd: root, backendId: 'mock', conversationId: 'main', createdAt: now, updatedAt: now }]
state.conversations = [
  { id: 'chat', title: '对话文件', kind: 'chat', cwd: root, backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now },
  { id: 'main', title: '项目文件', kind: 'project', projectId: 'project', cwd: root, backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now }
]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(8000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor(); await page.waitForLoadState('networkidle')
  await page.evaluate(() => localStorage.setItem('oc-width-panel', '480'))
  await page.reload(); await page.locator('.sidebar').waitFor(); await page.waitForLoadState('networkidle')
  const settle = () => page.evaluate(async () => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))
  })
  const open = async kind => {
    await resizeViewport(page, { width: 1360, height: 850 })
    await page.locator('.sidebar .nav-item').filter({ hasText: kind === 'chat' ? '对话文件' : '项目文件' }).first().click()
    if (kind === 'chat') {
      const toggle = page.locator('.side-pane-toggle')
      if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
      await page.locator('.side-pane [data-tab=files]').click()
    } else {
      if (!await page.locator('.panel').isVisible()) await page.locator('[data-panel-toggle]').click()
      await page.locator('.panel-head [data-tab=library]').click()
    }
    const surface = page.locator(kind === 'chat' ? '.side-pane' : '.panel')
    await surface.locator('.tree-row[data-path="测试"]').waitFor()
    await settle()
    return surface
  }
  const screenshot = async name => {
    await page.mouse.move(300, 25); await settle()
    await page.screenshot({ path: join(shots, name + '.png') })
  }
  const measurements = {}
  for (const kind of ['chat', 'project']) {
    const surface = await open(kind), pane = surface.locator('.files-pane')
    const conversation = page.locator(kind === 'chat' ? '.main > .workspace > .center' : '.main > .workspace > .center > .workspace > .center')
    assert.equal(await pane.locator('.files-preview').count(), 0, 'default state does not invent an open document')
    measurements[kind] = await pane.evaluate(el => {
      const row = el.querySelector('.tree-row'), box = el.getBoundingClientRect(), r = row.getBoundingClientRect(), icon = row.querySelector('svg').getBoundingClientRect()
      return { paneWidth: Math.round(box.width), rowHeight: r.height, iconInset: icon.x - box.x, fontSize: getComputedStyle(row).fontSize, background: getComputedStyle(row).backgroundColor }
    })
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
      await screenshot(kind + '-' + theme + '-default')
    }
    await pane.locator('.tree-row[data-path="测试"]').click()
    const editor = pane.locator('.preview-editor'); await editor.waitFor()
    assert.equal(await editor.inputValue(), text)
    assert(await pane.locator('.files-tree').evaluate(el => el.hidden))
    await screenshot(kind + '-reading-narrow')
    await editor.evaluate(el => { el.focus(); el.setSelectionRange(60, 68); el.scrollTop = 180 })
    const before = await editor.evaluate(el => ({ start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop }))
    const full = surface.locator(':scope > .pane-viewport > .panel-head').getByRole('button', { name: '全屏', exact: true })
    await full.click(); await settle()
    await pane.locator('.files-tree:not([hidden])').waitFor()
    assert.equal(await pane.locator('.preview-editor').inputValue(), text)
    assert.equal(await editor.evaluate(el => el.selectionStart), before.start)
    assert.equal(await editor.evaluate(el => el.selectionEnd), before.end)
    assert.equal(await pane.locator('.tree-row.active').getAttribute('data-path'), '测试')
    assert(await conversation.evaluate(el => el.inert))
    const geometry = await surface.evaluate(el => {
      const r = el.getBoundingClientRect(), w = document.querySelector('.main > .workspace').getBoundingClientRect()
      return { width: r.width, available: w.width, right: w.right - r.right, left: r.left - w.left, overflow: el.scrollWidth - el.clientWidth }
    })
    assert(geometry.width > geometry.available - 24, JSON.stringify(geometry))
    assert(geometry.right >= 0 && geometry.left >= 0 && geometry.overflow <= 1)
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
      await screenshot(kind + '-' + theme + '-expanded')
    }
    for (const width of [860, 640, 1360]) {
      await resizeViewport(page, { width, height: 850 })
      assert.equal(await editor.inputValue(), text)
      assert.equal(await editor.evaluate(el => el.selectionStart), before.start)
      assert(await surface.evaluate(el => el.classList.contains('maximized')))
    }
    // Opening a file's own workspace mode must consume only the first Escape.
    await pane.locator('button[data-focus-key="preview-full:测试"]').click()
    await page.locator('.file-full').waitFor()
    await page.keyboard.press('Escape'); await page.locator('.file-full').waitFor({ state: 'detached' })
    assert(await surface.evaluate(el => el.classList.contains('maximized')))
    await page.keyboard.press('Escape'); await settle()
    assert(!await surface.evaluate(el => el.classList.contains('maximized')))
    assert(!await conversation.evaluate(el => el.inert))
    assert.equal(await editor.evaluate(el => el.selectionStart), before.start)
    assert.equal(await editor.evaluate(el => el.selectionEnd), before.end)
    await resizeViewport(page, { width: 1800, height: 900 })
    // The stored pane width remains 480; widening the whole window does not
    // arbitrarily change the selected layout or discard the open document.
    assert(await pane.locator('.files-tree').evaluate(el => el.hidden))
    assert.equal(await editor.inputValue(), text)
    await resizeViewport(page, { width: 1360, height: 850 })
    await pane.getByRole('button', { name: '返回文件列表', exact: true }).click()
    assert(await pane.locator('.tree-row[data-path="测试"]').evaluate(el => el === document.activeElement))
  }
  assert.deepEqual(measurements.chat, measurements.project)
  // Closing an expanded ordinary-chat pane releases the covered conversation.
  const chat = await open('chat')
  await chat.locator(':scope > .pane-viewport > .panel-head').getByRole('button', { name: '全屏', exact: true }).click()
  await chat.getByRole('tab', { name: '后台', exact: true }).click(); await settle()
  assert(!await chat.evaluate(el => el.classList.contains('maximized')))
  assert(!await page.locator('.main > .workspace > .center').evaluate(el => el.inert))
  await chat.getByRole('tab', { name: '文件', exact: true }).click()
  await chat.locator(':scope > .pane-viewport > .panel-head').getByRole('button', { name: '全屏', exact: true }).click()
  await chat.locator(':scope > .pane-viewport > .panel-head').getByRole('button', { name: '关闭', exact: true }).click()
  await chat.waitFor({ state: 'detached' })
  assert(!await page.locator('.main > .workspace > .center').evaluate(el => el.inert))
  await page.locator('.side-pane-toggle').click()
  await chat.locator('.tree-row[data-path="测试"]').waitFor()
  assert(!await chat.evaluate(el => el.classList.contains('maximized')))
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())))
  console.log(JSON.stringify({ passed: true, measurements, shots, checks: ['same actual default state and file-row geometry', 'shared expansion control and split-preview behavior', 'extensionless text editing', 'caret and selection retained across three window widths', 'nested Escape closes one layer', 'underlying conversation restored', 'background does not inherit file expansion', 'close and reopen releases coverage and resets expansion'], hidden: true }, null, 2))
} catch (error) {
  await app.windows()[0]?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
