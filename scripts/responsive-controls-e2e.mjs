// Real hidden Electron checks. Catalog/selection only; never sends a model prompt.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-responsive-ui-')))
const cwd = mkdtempSync(join(tmpdir(), 'fenn-working-folder-'))
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
const backends = JSON.parse(readFileSync(join(data, 'backends.json'), 'utf8'))
backends.find((backend) => backend.id === 'mock').name = 'Example Agent with a longer name'
writeFileSync(join(data, 'backends.json'), JSON.stringify(backends))
const project = randomUUID(), main = randomUUID(), thread = randomUUID(), now = Date.now()
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light' }
state.projects = [{ id: project, name: '自适应布局检查', conversationId: main, cwd, backendId: 'mock', createdAt: now, updatedAt: now }]
state.conversations = [
  { id: main, kind: 'project', projectId: project, title: '自适应布局检查', backendId: 'mock', cwd, status: 'idle', createdAt: now, updatedAt: now },
  { id: thread, kind: 'thread', projectId: project, title: '缩放与设置保留', backendId: 'mock', cwd, status: 'idle', createdAt: now, updatedAt: now }
]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const shots = join(data, 'shots')
mkdirSync(shots)
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const resize = async (width) => { await resizeViewport(page, { width, height: 900 }); await settle() }
const showPanel = async () => { if (!await page.locator('.panel').isVisible()) await page.locator('[data-panel-toggle]').click() }
try {
  await page.waitForSelector('.sidebar')
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible())))
  await resize(1600)
  await page.locator('.recent-projects .nav-item').filter({ hasText: '自适应布局检查' }).click()
  await page.locator('.panel-head [aria-label="全屏"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.panel-head [data-tab]').length === 2)
  assert.equal(await page.locator('[data-more]').count(), 1, 'The restored navigation keeps secondary destinations in More')
  await page.locator('[data-more]').click()
  await page.getByRole('menuitemradio', { name: '项目记忆', exact: true }).click()
  await page.locator('.memory-manager').waitFor()
  await page.locator('.panel-head [aria-label="退出全屏"]').click()
  for (const width of [1600, 1200, 1000, 800, 640, 1200, 1600]) {
    await resize(width); await showPanel(); await settle()
    const active = page.locator('[data-tab="memory"]')
    assert(await active.isVisible(), 'Selected destination stays visible through resizing')
    const head = page.locator('.panel .panel-head')
    const rect = await head.boundingBox()
    for (const button of await head.locator('button').all()) {
      const b = await button.boundingBox()
      if (b) assert(b.x >= rect.x - 1 && b.x + b.width <= rect.x + rect.width + 1, 'Navigation actions must not clip')
    }
  }
  await page.locator('[data-tab="threads"]').click()
  await page.locator('.thread-row').filter({ hasText: '缩放与设置保留' }).click()
  await page.locator('.thread-view .model-btn').filter({ hasText: 'Mock Fast' }).waitFor({ state: 'attached' })
  await page.locator('.thread-view .panel-head [data-tip="全屏"]').click()
  await page.locator('.thread-view .model-group:not(.compact)').waitFor()
  // A model choice is available before sending a first message.
  await page.locator('.thread-view .model-btn').click()
  await page.locator('.menu .menu-item').filter({ hasText: 'Mock Smart' }).click()
  await page.locator('.thread-view .model-btn').filter({ hasText: 'Mock Smart' }).waitFor()
  const labels = await page.locator('.thread-view .model-controls').innerText()
  await page.locator('.thread-view .panel-head [data-tip="退出全屏"]').click()
  let sawCompact = false
  for (const width of [1600, 1200, 1000, 800, 640, 1200, 1600]) {
    await resize(width); await showPanel(); await settle()
    const row = page.locator('.thread-view .composer-row')
    assert(!(await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1)), 'Composer must not overflow')
    const compact = await row.locator('.model-group.compact').count() > 0
    sawCompact ||= compact
    if (compact) {
      assert(await row.locator('.model-settings').isVisible(), 'Narrow composers retain a settings entry')
      assert.equal(await row.locator('.model-controls button').first().evaluate((el) => getComputedStyle(el).visibility), 'hidden')
    }
    assert.equal(await row.locator('.context-ring').count(), 0, 'Unreported context/account values remain absent')
    assert(await row.locator('.send-btn').isVisible(), 'Send remains available')
    assert((await row.locator('.model-controls').textContent()).includes('Mock Smart'), 'Resizing preserves the model')
  }
  assert(sawCompact, 'The fixture must exercise real overflow')
  // Open a compact menu, then expand. It closes cleanly instead of floating by an invisible anchor.
  await resize(800); await showPanel(); await settle()
  await page.locator('.thread-view .model-settings').click()
  await page.locator('.menu').waitFor()
  await resize(1600)
  await page.locator('.thread-view .panel-head [data-tip="全屏"]').click()
  await page.locator('.thread-view .model-group:not(.compact)').waitFor()
  assert.equal(await page.locator('.menu').count(), 0)
  assert.equal(await page.locator('.thread-view .model-controls').innerText(), labels, 'Widening changes presentation only')
  await page.screenshot({ path: join(shots, 'full-controls.png') })
  assert.equal((await page.evaluate((id) => window.fenn.messages(id), thread)).length, 0, 'Checking the UI must not send a prompt')
  assert.deepEqual(errors, [])
  console.log('PASS: actual-space navigation, active view, repeated resizing, compact/full settings, first-message model choice and no prompts')
  console.log('RESPONSIVE_UI_PROFILE', data)
} catch (error) {
  await page.screenshot({ path: join(data, 'failure.png') }).catch(() => {})
  console.error('RESPONSIVE_UI_FAILED', data)
  throw error
} finally { await app.close() }
