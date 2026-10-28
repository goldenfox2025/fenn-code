// Hidden Electron regression: account quota and session context have separate scopes.
// Backend IPC is replaced in this isolated process; no CLI/account requests or prompts.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-usage-scope-')))
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
const now = Date.now()
const usage = contextShare => ({ input: 0, output: 0, turns: 1, unreported: 0, contextShare, contextSource: 'log' })
const chat = (id, backendId, extra = {}) => ({ id, backendId, kind: 'chat', title: id, status: 'idle', createdAt: now, updatedAt: now, ...extra })
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0 }
state.conversations = [
  chat('Qoder 上下文检查', 'qoder', { usage: usage(.35), compactCommand: '/compact' }),
  chat('Qoder 无上下文', 'qoder'),
  chat('Codex 上下文检查', 'codex', { usage: { ...usage(undefined), contextUsed: 18000, contextSize: 200000 } }),
  chat('无账户额度后端', 'mock', { usage: usage(.12) }),
  chat('额度检查主对话', 'qoder', { kind: 'project', projectId: 'quota-project', usage: usage(.25) }),
  chat('额度检查讨论串', 'codex', { kind: 'thread', projectId: 'quota-project', usage: usage(.55) })
]
state.projects = [{ id: 'quota-project', name: '额度范围检查', backendId: 'qoder', conversationId: '额度检查主对话', createdAt: now, updatedAt: now }]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const shots = join(data, 'shots')
mkdirSync(shots)
const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', e => errors.push(e.message))
try {
  await page.waitForSelector('.sidebar')
  await page.waitForLoadState('networkidle')
  await app.evaluate(({ ipcMain }) => {
    globalThis.quotaFixture = {
      qoder: { buckets: [{ name: 'Organization', used: 8998, total: 50000, remaining: 41002, unit: 'credits' }], at: Date.now() },
      codex: { buckets: [{ name: '5 hour', used: 42, total: 100, remaining: 58, unit: '%' }], at: Date.now() }
    }
    for (const [method, read] of [
      ['backendCredits', (_event, id) => globalThis.quotaFixture[id]],
      ['backendModels', () => ({ models: [{ id: 'fixture', name: 'Fixture model' }], current: 'fixture', options: [] })],
      ['prepareConversation', () => {}]
    ]) {
      ipcMain.removeHandler(`oc:${method}`)
      ipcMain.handle(`oc:${method}`, read)
    }
  })
  const openChat = async title => {
    await page.locator('.sidebar .nav-item').filter({ hasText: title }).click()
    await page.locator('.chat-header').waitFor()
  }
  await resizeViewport(page, { width: 1440, height: 960 })
  await openChat('Qoder 上下文检查')
  const account = page.locator('.topbar .account-quota')
  const context = page.locator('.composer .context-ring')
  await account.waitFor()
  assert.match(await account.innerText(), /Qoder.*18%/s)
  assert.match(await context.getAttribute('aria-label'), /35%/)
  assert.equal(await page.locator('.composer .account-quota').count(), 0)
  await account.click()
  assert.match(await page.locator('.menu').innerText(), /账户额度.*8,998.*50,000/s)
  assert(!/上下文|压缩/.test(await page.locator('.menu').innerText()), 'Account menu contains no session controls')
  await page.screenshot({ path: join(shots, 'account-light-wide.png') })
  await page.keyboard.press('Escape')
  await context.click()
  assert.match(await page.locator('.menu').innerText(), /本对话用量.*上下文.*35%/s)
  assert(!/账户额度|credits|其他会话/.test(await page.locator('.menu').innerText()))
  assert.equal(await page.getByRole('menuitem', { name: '压缩上下文', exact: true }).count(), 1)
  await page.screenshot({ path: join(shots, 'context-light-wide.png') })
  // A live context update must refresh the already-open panel, without quota substitution.
  await app.evaluate(({ BrowserWindow }, conversation) => BrowserWindow.getAllWindows()[0].webContents.send('oc:event', { type: 'conversation', conversation }),
    { ...state.conversations[0], usage: usage(.37) })
  await page.waitForFunction(() => document.querySelector('.menu')?.textContent.includes('37%'))
  await page.keyboard.press('Escape')
  await openChat('Qoder 无上下文')
  assert.equal(await context.count(), 0, 'Missing context is not replaced by an account quota')
  assert.match(await account.innerText(), /18%/)
  await openChat('Codex 上下文检查')
  await page.getByRole('button', { name: 'Codex 账户额度', exact: true }).waitFor()
  assert.match(await account.innerText(), /42%/)
  assert.match(await context.getAttribute('aria-label'), /18\.0k.*200k.*9%/)
  for (const [theme, width] of [['light', 1440], ['dark', 620], ['light', 500]]) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
    await resizeViewport(page, { width, height: 900 })
    await account.click()
    const bar = await page.locator('.topbar').boundingBox(), a = await account.boundingBox()
    const menu = await page.locator('.menu').boundingBox()
    assert(a.y >= bar.y && a.y + a.height <= bar.y + bar.height + 1)
    assert(a.x + a.width <= width && menu.x >= 0 && menu.x + menu.width <= width + 1)
    assert(menu.y >= a.y + a.height - 1, 'Quota opens below the top-right control')
    await page.screenshot({ path: join(shots, `account-${theme}-${width}.png`) })
    await page.keyboard.press('Escape')
    await context.click()
    assert.match(await page.locator('.menu').innerText(), /18\.0k.*200k.*9%/)
    await page.screenshot({ path: join(shots, `context-${theme}-${width}.png`) })
    await page.keyboard.press('Escape')
  }
  await resizeViewport(page, { width: 1440, height: 960 })
  await page.locator('.recent-projects .nav-item').filter({ hasText: '额度范围检查' }).click()
  await page.getByRole('button', { name: 'Qoder 账户额度', exact: true }).waitFor()
  await page.locator('.thread-row').filter({ hasText: '额度检查讨论串' }).click()
  await page.getByRole('button', { name: 'Codex 账户额度', exact: true }).waitFor()
  assert.match(await page.locator('.thread-view .context-ring').getAttribute('aria-label'), /55%/)
  assert.match(await page.locator('.workspace > .center > .composer-wrap .context-ring').getAttribute('aria-label'), /25%/)
  await openChat('无账户额度后端')
  assert.equal(await account.count(), 0, 'Unsupported account quotas take no space')
  assert.match(await context.getAttribute('aria-label'), /12%/)
  await app.evaluate(() => { globalThis.quotaFixture.qoder = undefined })
  await openChat('Qoder 上下文检查')
  await page.waitForTimeout(150)
  assert.equal(await account.count(), 0, 'A missing account snapshot is not a zero balance')
  assert.match(await context.getAttribute('aria-label'), /37%/)
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log('PASS: independent quota/context scopes, Qoder share, Codex tokens, live updates, missing values, project/thread routing, themes and widths; no model calls')
  console.log('USAGE_SCOPE_PROFILE', data)
} catch (error) {
  await page.screenshot({ path: join(data, 'failure.png') }).catch(() => {})
  console.error('USAGE_SCOPE_FAILED', data)
  throw error
} finally { await app.close() }
