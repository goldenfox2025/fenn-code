// Rendered UI inventory. All data is copied from an isolated fixture; no real account prompts.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resizeViewport } from './electron-ui.mjs'

// Reuse the fixture builder instead of maintaining a second project/review schema.
// Pass REVIEW_UI_PROFILE from review-workflow-e2e.mjs as the third argument or env.
const fixture = process.env.FENN_AUDIT_FIXTURE || process.argv[3]
if (!fixture || !existsSync(join(fixture, 'state.json'))) throw new Error('Pass the REVIEW_UI_PROFILE emitted by scripts/review-workflow-e2e.mjs: node scripts/ui-surface-audit.mjs <shots> <profile>')
const data = mkdtempSync(join(tmpdir(), 'fenn-all-ui-'))
for (const name of ['state.json', 'backends.json', 'messages', 'projects']) if (existsSync(join(fixture, name))) cpSync(join(fixture, name), join(data, name), { recursive: true })
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
state.settings = { ...state.settings, language: 'zh', theme: 'light', onboarded: true, notifications: false, runInBackground: false }
state.routines = []
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const project = state.projects.find((p) => p.name === '并行验收试验 · 测试数据')
const materials = join(data, 'projects', project.id, 'files')
mkdirSync(materials, { recursive: true })
writeFileSync(join(materials, '参考说明.md'), '# 项目资料\n\n用于验收资料分组与共享编辑器。')
const shots = process.argv[2] || join(data, 'shots')
mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
const report = []
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.sidebar')
  let width = 1440, theme = 'light'
  const settle = () => page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const sidebar = async () => {
    if (await page.locator('.sidebar').evaluate((el) => el.classList.contains('closed'))) await page.locator('.topbar button').filter({ has: page.locator('svg.lucide-panel-left') }).click()
  }
  const fold = async () => { if (width < 850 && !await page.locator('.sidebar').evaluate((el) => el.classList.contains('closed'))) await page.locator('.sidebar button[data-tip^="收起侧栏"]').click() }
  const nav = async (label) => {
    await sidebar()
    await page.locator('.sidebar .nav > button').filter({ has: page.locator('.label').filter({ hasText: new RegExp(`^${label}$`) }) }).click()
    await fold()
  }
  const shot = async (name) => {
    await settle()
    const issues = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden], [inert]') }
      const describe = (el) => `${el.tagName.toLowerCase()}.${String(el.className).replace(/\s+/g, '.')} ${(el.textContent || '').trim().slice(0, 45)}`
      const unnamed = [...document.querySelectorAll('button')].filter((el) => visible(el) && !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.title).map(describe)
      const overflow = [...document.querySelectorAll('.center, .page, .modal, .settings-body, .panel, .thread-review, .review-control-row, .composer-row')].filter((el) => visible(el) && el.scrollWidth > el.clientWidth + 2).map((el) => ({ element: describe(el), overflow: el.scrollWidth - el.clientWidth, descendants: [...el.querySelectorAll('*')].filter((child) => visible(child) && child.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).slice(0, 8).map(describe) }))
      return { unnamed, overflow }
    })
    report.push({ name, theme, width, ...issues })
    await page.screenshot({ path: join(shots, `${theme}-${width}-${name}.png`) })
  }
  const settings = async () => { await sidebar(); await page.locator('.sidebar-foot').getByRole('button', {name:'设置',exact:true}).click(); await page.locator('.settings-modal').waitFor() }
  const openProject = async () => {
    await sidebar()
    await page.locator('.recent-projects .nav-item').filter({ hasText: project.name }).click()
    await fold()
    if (!await page.locator('.panel').isVisible()) await page.locator('[data-panel-toggle]').click()
  }
  const tab = async (id) => {
    const direct = page.locator(`.panel-head [data-tab="${id}"]`)
    if (await direct.isVisible()) { if(await direct.getAttribute('aria-selected')!=='true')await direct.click() }
    else {
      await page.locator('.panel-head [data-more]').click()
      const label = { memory: '项目记忆', routines: '定时任务', library: '库', threads: '讨论串' }[id]
      await page.locator('.menu').getByRole('menuitemradio', { name: label, exact: true }).click()
    }
  }
  for (const look of [{ theme: 'light', width: 1440 }, { theme: 'light', width: 620 }, { theme: 'dark', width: 1000 }]) {
    ;({ theme, width } = look)
    await page.evaluate((theme) => window.fenn.updateSettings({ theme }), theme)
    await resizeViewport(page, { width, height: 900 })
    for (const [label, name] of [['新建', 'home'], ['项目', 'projects'], ['对话', 'chats'], ['定时任务', 'routines']]) { await nav(label); await shot(name) }
    await page.getByRole('button', { name: '新建定时任务', exact: true }).click()
    await shot('routine-form')
    await page.keyboard.press('Escape')
    await nav('项目')
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await shot('project-form')
    await page.keyboard.press('Escape')
    await settings()
    for (const [label, name] of [['通用', 'general'], ['外观', 'appearance'], ['Agent 后端', 'backends'], ['连接器', 'connectors'], ['关于', 'about']]) {
      await page.locator('.settings-nav').getByRole('button', { name: label, exact: true }).click()
      await shot(`settings-${name}`)
    }
    await page.keyboard.press('Escape')
    await openProject()
    await shot('project-threads')
    for (const id of ['library', 'memory', 'routines']) { await tab(id); await shot(`project-${id}`) }
    await tab('library')
    await page.locator('.files-pane').waitFor()
    await page.getByRole('button', { name: '添加的资料', exact: true }).click()
    await page.locator('.tree-row[data-path="/@materials/参考说明.md"]').waitFor()
    await shot('project-library-attachments')
    await tab('threads')
    await page.locator('.thread-row').filter({ hasText: '队列条目 1' }).click()
    await page.locator('.thread-review').waitFor()
    await shot('review-collapsed')
    await page.locator('.review-actions').getByRole('button', { name: '提出意见', exact: true }).click()
    await shot('review-feedback')
    await page.locator('.review-feedback textarea').fill('修正计算结果，并附上实际验证结果。')
    await page.locator('.review-controls').getByRole('button', {name:'取消',exact:true}).click()
    await shot('review-expanded')
    const bounds = await page.evaluate(() => {
      const pane = document.querySelector('.thread-view').getBoundingClientRect(), head = document.querySelector('.thread-view .panel-head').getBoundingClientRect(), card = document.querySelector('.thread-review').getBoundingClientRect(), details = document.querySelector('.review-detail-popover').getBoundingClientRect()
      return { inside: details.left >= pane.left && details.right <= pane.right && details.top >= head.bottom && details.bottom <= card.top + 1, aligned: Math.abs(details.left - card.left) <= 1 && Math.abs(details.right - card.right) <= 1, headerBottom: head.bottom, detailTop: details.top }
    })
    report.push({ name: 'review-containment', theme, width, ...bounds })
    if (!bounds.inside || !bounds.aligned) throw new Error(`Review boundaries fail: ${JSON.stringify(bounds)}`)
    await page.getByRole('button', { name: '收起审核详情', exact: true }).click()
  }
  await nav('新建')
  await page.evaluate(() => localStorage.setItem('oc-width-panel', '600'))
  await page.locator('.composer textarea').fill('你好')
  await page.locator('.composer textarea').press('Enter')
  await page.locator('.turn .md').first().waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => !document.querySelector('.turn.streaming'))
  await shot('ordinary-chat')
  width = 860
  await resizeViewport(page, { width, height: 900 })
  await page.locator('.side-pane-toggle').click()
  await page.locator('.side-pane').waitFor()
  await page.locator('.side-pane').getByRole('tab', {name:'文件',exact:true}).click()
  await shot('ordinary-files-saved-width')
  const pane = page.locator('.side-pane')
  if (!await pane.evaluate((el) => el.getBoundingClientRect().width >= 360 && el.getBoundingClientRect().right <= innerWidth)) throw new Error('The restored files workspace must stay inside the window')
  if (await pane.getByRole('tab', { name: '讨论串', exact: true }).count()) throw new Error('Ordinary chats must not acquire project navigation')
  await pane.getByRole('tab', { name: '文件', exact: true }).press('ArrowRight')
  if (await pane.getByRole('tab', { name: /^后台/ }).getAttribute('aria-selected') !== 'true') throw new Error('Chat tabs must support the shared arrow-key behavior')
  await shot('ordinary-background-empty')
  await pane.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => window.fenn.updateSettings({ onboarded: false }))
  await page.locator('.onboarding').waitFor()
  await shot('onboarding')
  await page.locator('.onboarding').getByRole('button', { name: '继续', exact: true }).click()
  await shot('onboarding-backends')
  await page.locator('.onboarding').getByRole('button', { name: '继续', exact: true }).click()
  await shot('onboarding-project')
  if (errors.length) throw new Error(errors.join('\n'))
  const defects = report.filter(r => r.unnamed?.length || r.overflow?.length)
  if (defects.length) throw new Error('Rendered surface defects: ' + JSON.stringify(defects))
  writeFileSync(join(shots, 'surface-report.json'), JSON.stringify(report, null, 2))
  console.log('SURFACE_AUDIT', JSON.stringify({ data, shots, surfaces: report.length, unnamed: report.filter((r) => r.unnamed?.length).length, overflow: report.filter((r) => r.overflow?.length).length }))
} catch (error) {
  writeFileSync(join(shots, 'surface-report.json'), JSON.stringify(report, null, 2))
  console.error('SURFACE_AUDIT_FAILED', JSON.stringify({ data, shots }))
  throw error
} finally { await app.close() }
