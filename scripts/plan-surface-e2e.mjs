// Hidden Electron acceptance. Fixture events only; no live-provider inference.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-plan-surface-')))
const cwd = mkdtempSync(join(tmpdir(), 'fenn-plan-work-'))
const shots = resolve('.local/plan-sidebar-ui')
mkdirSync(shots, { recursive: true })
for (const name of ['README.md', 'plan.ts', 'layout.css']) writeFileSync(join(cwd, name), name === 'README.md' ? '# 阅读工作区\n\n文件、计划和讨论都保留在同一处。' : '// fixture')
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
const now = Date.now(), id = 'plan-chat'
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0 }
state.conversations = [{ id, kind: 'chat', title: '检查计划与侧栏', backendId: 'mock', cwd, status: 'idle', createdAt: now, updatedAt: now }]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
mkdirSync(join(data, 'messages'))
writeFileSync(join(data, 'messages', `${id}.json`), JSON.stringify(Array.from({ length: 8 }, (_, i) => [
  { id: `u${i}`, conversationId: id, role: 'user', createdAt: now + i, blocks: [{ type: 'text', text: i === 7 ? '把计划放在当前工作末尾，并检查阅读位置。' : `检查第 ${i + 1} 项界面。` }] },
  { id: `a${i}`, conversationId: id, role: 'assistant', state: 'done', createdAt: now + i, blocks: [{ type: 'text', text: i === 7 ? '已核对布局与数据来源。接下来验证窄窗口、键盘操作和中断状态。' : '检查内容的对齐、留白和状态提示。'.repeat(30) }] }
]).flat()))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await app.firstWindow(), errors = []
  page.setDefaultTimeout(8000)
  page.on('pageerror', e => errors.push(e.message))
  await page.locator('.sidebar').waitFor()
  await page.locator('.sidebar .nav-item').filter({ hasText: '检查计划与侧栏' }).click()
  const plan = page.locator('.plan-line'), scroll = page.locator('.transcript-shell > .scroll')
  const patch = value => page.evaluate(({ id, value }) => window.fenn.updateConversation(id, value), { id, value })
  const checklist = (complete = false) => Array.from({ length: 14 }, (_, i) => `${complete || i < 5 ? '✓' : i === 5 ? '✱' : '○'} ${['核对当前布局', '读取后端计划', '检查文件入口', '整理工具栏', '验证键盘操作', '检查窄窗口中的对齐和滚动位置', '核对审核流程'][i % 7]}`).join('\n')
  const settle = () => page.evaluate(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)) })
  await patch({ checklist: checklist(), checklistAuto: false, status: 'working' })
  await plan.locator('.plan-body').waitFor()
  assert.equal(await plan.count(), 1)
  assert(await plan.evaluate(el => el.parentElement.classList.contains('transcript') && el === el.parentElement.lastElementChild))
  assert.equal(await plan.locator('.plan-step').count(), 6)
  assert.equal(await plan.locator('.step-icon.live').count(), 1)
  await plan.evaluate(el => { el.dataset.instanceProof = 'retained' })
  await scroll.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); el.scrollTop = 240 })
  await patch({ checklist: checklist().replace('检查窄窗口中的对齐和滚动位置', '检查长文本：' + '核对界面边界和滚动位置。'.repeat(20)) })
  await settle()
  assert.equal(await plan.getAttribute('data-instance-proof'), 'retained', 'Updates reuse the card')
  assert(Math.abs(await scroll.evaluate(el => el.scrollTop) - 240) < 1, 'Plan updates do not pull readers away from earlier messages')
  await plan.locator('.plan-more').click()
  assert.equal(await plan.locator('.plan-step').count(), 14)
  assert(await plan.locator('.plan-body').evaluate(el => el.clientHeight <= 321 && el.scrollHeight > el.clientHeight))
  await plan.locator('.plan-more').click()
  await patch({ status: 'idle' })
  await page.waitForFunction(() => document.querySelector('.plan-text')?.textContent === '计划未完成')
  assert.equal(await plan.locator('.step-icon.live').count(), 0)
  await patch({ checklist: checklist(true) })
  await plan.locator('.plan-body').waitFor({ state: 'detached' })
  assert.equal(await plan.locator('.plan-text').innerText(), '计划已完成')
  await plan.locator('.plan-summary').focus()
  await page.keyboard.press('Enter')
  await plan.locator('.plan-body').waitFor()
  await page.keyboard.press('Enter')
  assert(await plan.locator('.steps-fold').evaluate(el => el.inert), 'Closing plan loses interaction immediately')
  await plan.locator('.plan-body').waitFor({ state: 'detached' })

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
    for (const width of [1360, 860, 640]) {
      await resizeViewport(page, { width, height: 850 })
      await patch({ checklist: checklist(), status: 'working' })
      await plan.locator('.plan-body').waitFor()
      await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
      await settle()
      const geometry = await plan.evaluate(el => {
        const r = el.getBoundingClientRect(), t = el.parentElement, tr = t.getBoundingClientRect(), css = getComputedStyle(t)
        return { left: r.left - tr.left - parseFloat(css.paddingLeft), right: tr.right - parseFloat(css.paddingRight) - r.right, width: el.clientWidth, content: el.scrollWidth }
      })
      assert(Math.abs(geometry.left) < 1 && Math.abs(geometry.right) < 1 && geometry.content <= geometry.width + 1, JSON.stringify(geometry))
      if (width === 1360) {
        await page.locator('.side-pane-toggle').click()
        await page.locator('.files-pane .tree-row').filter({ hasText: 'README.md' }).waitFor()
        await page.locator('.files-head [aria-label="筛选文件"]').click()
        await page.locator('.files-filter input').fill('layout')
        assert.equal(await page.locator('.tree-row:visible').count(), 1)
        await page.keyboard.press('Escape')
        await settle()
      }
      // Opening the file pane changes text wrapping. Navigate to the final
      // message after that reflow so the screenshot actually shows the plan.
      await scroll.evaluate(el => { el.scrollTop = el.scrollHeight })
      await settle()
      assert(await plan.evaluate(el => { const r = el.getBoundingClientRect(), viewport = el.closest('.scroll').getBoundingClientRect(); return r.top >= viewport.top && r.bottom <= viewport.bottom + 1 }), 'The complete bounded plan is visible above the composer')
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(shots, `${theme}-${width}.png`), Buffer.from(png, 'base64'))
      if (width === 1360) await page.locator('.side-pane-toggle').click()
      await patch({ status: 'idle' })
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await plan.locator('.plan-summary').click()
  await plan.locator('.plan-body').waitFor({ state: 'detached' })
  await patch({ checklist: undefined, status: 'idle' })
  await plan.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log('PASS plan: transcript placement, in-place updates, long plans, no scroll stealing, stop/completion, keyboard, reduced motion; sidebar filtering; light/dark at 1360/860/640.')
  console.log(shots)
} finally { await app.close() }
