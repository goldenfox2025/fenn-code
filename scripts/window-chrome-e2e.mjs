// Hidden fixture: exercise native window-state IPC without entering the user's desktop fullscreen.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-chrome-')))
const statePath = join(data, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'))
state.settings = { ...state.settings, onboarded: true, theme: 'dark', language: 'zh', dotGrid: 0 }
state.conversations = [{ id: 'chrome-chat', kind: 'chat', title: '全屏布局检查', backendId: 'mock', status: 'idle', createdAt: Date.now(), updatedAt: Date.now() }]
writeFileSync(statePath, JSON.stringify(state))
const shots = resolve('.local/window-chrome-ui'); mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await app.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor()
  await resizeViewport(page, { width: 1440, height: 900 })
  await page.locator('.sidebar .nav-item').filter({ hasText: '全屏布局检查' }).click()
  const mac = () => page.evaluate(() => { document.documentElement.classList.remove('not-mac'); document.documentElement.classList.add('mac') })
  const changeNativeState = async fullscreen => {
    await app.evaluate(({ BrowserWindow }, fullscreen) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.__fixtureFullscreen = fullscreen
      window.isFullScreen = () => window.__fixtureFullscreen
      window.emit(fullscreen ? 'enter-full-screen' : 'leave-full-screen')
    }, fullscreen)
    await page.waitForFunction(value => document.documentElement.classList.contains('window-fullscreen') === value, fullscreen)
  }
  const settle = () => page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  const openSidebar = async () => {
    if (await page.locator('.sidebar.closed').count()) await page.locator('.topbar .sidebar-toggle').click()
    await settle()
  }
  const closeSidebar = async () => {
    await page.locator('.sidebar:not(.closed) .sidebar-top > .icon-btn').first().click()
    await settle()
  }
  await mac()
  for (const fullscreen of [false, true, false, true, false]) {
    await openSidebar()
    const composer = page.locator('.composer textarea')
    await composer.fill('保留未发送的草稿'); await composer.focus()
    await changeNativeState(fullscreen)
    assert(await composer.evaluate(el => document.activeElement === el), 'Fullscreen must preserve the focused editor')
    assert.equal(await composer.inputValue(), '保留未发送的草稿')
    const padding = await page.locator('.sidebar-top').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))
    assert(fullscreen ? padding < 40 : padding === 80, `Expanded sidebar inset: ${padding}`)
    await closeSidebar()
    const margin = await page.locator('.topbar .sidebar-toggle').evaluate(el => parseFloat(getComputedStyle(el).marginLeft))
    assert.equal(margin, fullscreen ? 0 : 70, 'Collapsed sidebar only reserves space for visible traffic lights')
    if (fullscreen) await page.screenshot({ path: join(shots, 'fullscreen-collapsed.png') })
  }
  // The initial state query and did-finish-load must restore chrome after a reload.
  await changeNativeState(true)
  await page.reload(); await page.locator('.sidebar').waitFor()
  await page.waitForFunction(() => document.documentElement.classList.contains('window-fullscreen'))
  await page.locator('.sidebar .nav-item').filter({ hasText: '全屏布局检查' }).click()
  await mac(); await openSidebar()
  assert(await page.locator('.sidebar-top').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft) < 40))
  await changeNativeState(false)
  await page.screenshot({ path: join(shots, 'restored-expanded.png') })
  await closeSidebar()
  const title = page.locator('.chat-header .chat-title')
  await title.click()
  assert.equal(await title.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'Pointer clicks do not paint a keyboard focus ring')
  await page.keyboard.press('Tab'); await title.focus()
  assert(await title.evaluate(el => el.matches(':focus-visible')), 'Keyboard focus must remain visible')
  await title.press('Enter'); await page.locator('.chat-header .rename-input').waitFor()
  await page.keyboard.press('Escape')
  await page.evaluate(() => { document.documentElement.classList.remove('mac'); document.documentElement.classList.add('not-mac') })
  assert.equal(await page.locator('.topbar .sidebar-toggle').evaluate(el => parseFloat(getComputedStyle(el).marginLeft)), 0, 'Windows/Linux do not reserve traffic-light space')
  await openSidebar()
  assert(await page.locator('.sidebar-top').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft) < 40))
  assert.deepEqual(errors, [])
  console.log('PASS native state IPC, repeated fullscreen transitions, expanded/collapsed insets, reload, draft/focus preservation, keyboard rename, and Windows/Linux spacing')
  console.log('Native macOS Space animations require a macOS run of package-smoke.mjs; this fixture simulates its native events only.')
} finally { await app.close() }
