// Hidden render checks for shared surface depth, opaque transitions and disclosures.
// All content is local fixture data; no prompt reaches a live backend.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const shots = resolve('.local/claude-ui')
mkdirSync(shots, { recursive: true })
const settle = page => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))
})
async function opaque(page, selector) {
  const sample = await page.locator(selector).evaluate(el => {
    const animations = el.getAnimations()
    for (const animation of animations) {
      if (animation.effect?.getTiming().iterations === Infinity) continue
      animation.pause()
      animation.currentTime = Number(animation.effect.getTiming().duration) * .35
    }
    const ancestors = []
    for (let item = el; item; item = item.parentElement) ancestors.push(Number(getComputedStyle(item).opacity))
    const background = getComputedStyle(el).backgroundColor
    const translucent = background === 'transparent' || /rgba\([^)]*,\s*0(?:\.\d+)?\)/.test(background)
    animations.forEach(a => { if (a.effect?.getTiming().iterations !== Infinity) a.finish() })
    return { ancestors, background, translucent }
  })
  assert(sample.ancestors.every(value => value === 1) && !sample.translucent, `${selector} must not blend its text with the page: ${JSON.stringify(sample)}`)
}
async function capture(app, page, name) {
  await settle(page)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(shots, `${name}.png`), Buffer.from(png, 'base64'))
}
async function nodeClearance(page, kind) {
  const rail = page.locator('.conversation-nodes')
  await rail.locator('.conversation-node').first().hover()
  await settle(page)
  const bounds = await rail.evaluate((el, kind) => {
    const shell = el.closest(kind === 'bot' ? '.history-wrap' : '.transcript-shell').getBoundingClientRect()
    const rail = el.getBoundingClientRect()
    const content = [...document.querySelectorAll(kind === 'bot' ? '.message' : '.msg .md, .msg-user .bubble')].map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0)
    return { edge: rail.left - shell.left, clearance: Math.min(...content.map(rect => rect.left - rail.right)), peak: el.querySelector('.conversation-node:hover > span').getBoundingClientRect().width }
  }, kind)
  assert(Math.abs(bounds.edge - 8) < .5 && bounds.clearance >= 3.5 && Math.abs(bounds.peak - 24) < .5, `${kind} node rail has breathing room without covering prose: ${JSON.stringify(bounds)}`)
  await page.mouse.move(0, 0)
}

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-material-code-')))
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
const now = Date.now(), chat = 'material-chat', cwd = mkdtempSync(join(tmpdir(), 'fenn-material-work-'))
writeFileSync(join(cwd, 'README.md'), '# 界面检查\n\n检查真实布局、键盘导航与滚动位置。')
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0 }
state.conversations = [{ id: chat, kind: 'chat', backendId: 'mock', title: '界面与交互检查', cwd, status: 'idle', createdAt: now, updatedAt: now }]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
mkdirSync(join(data, 'messages'))
const messages = Array.from({ length: 9 }, (_, i) => [
  { id: `u${i}`, conversationId: chat, role: 'user', createdAt: now + i, blocks: [{ type: 'text', text: i === 8 ? '检查这轮修改，保留清楚的层次和稳定的交互。' : `第 ${i + 1} 项：核对窗口缩放和长内容阅读。` }] },
  { id: `a${i}`, conversationId: chat, role: 'assistant', state: 'done', createdAt: now + i, blocks: [
    ...(i === 8 ? [
      { type: 'thought', text: '先核对通用控件和容器宽度，再检查菜单与正文的层次。\n\n保留已有导航结构，逐项检查实际交互。', ms: 2400 },
      ...Array.from({ length: 3 }, (_, n) => ({ type: 'tool', toolId: `check${n}`, title: `检查 component-${n}.tsx`, toolKind: 'read', status: 'completed', input: '{}', output: '尺寸与状态已核对。' }))
    ] : []),
    { type: 'text', text: i === 8 ? '已完成这一轮检查。\n\n- **层次**：正文、控件与菜单各有自己的表面。\n- **布局**：空间足够时显示完整选项，变窄时保留必要操作。\n- **阅读**：向上查看内容时，新的进展不会抢走阅读位置。\n\n文件仍在右侧的库中，现有的项目审核流程保持可用。' : '正文保持正常排版，操作仅在需要时出现。\n\n' + '用户正在阅读的内容应留在原来的位置。'.repeat(5) }
  ] }
]).flat()
writeFileSync(join(data, 'messages', `${chat}.json`), JSON.stringify(messages))
const code = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await code.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor()
  await page.locator('.sidebar .nav-item').filter({ hasText: '界面与交互检查' }).click()
  const files = await page.evaluate(() => window.fenn.listLibrary('material-chat'))
  assert(files?.entries.some(entry => entry.name === 'README.md'), 'Fixture working folder is available')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme, dotGrid: 0 }), theme)
    for (const width of [1360, 860, 640]) {
      await resizeViewport(page, { width, height: 850 })
      await nodeClearance(page, 'code')
      assert(await page.locator('.composer-row').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Composer controls stay inside their row')
      const control = page.locator('.composer .model-btn:visible, .composer .model-settings:visible').first()
      await control.click()
      await opaque(page, '.menu')
      await capture(code, page, `code-${theme}-${width}-menu`)
      await page.keyboard.press('Escape')
    }
    await resizeViewport(page, { width: 1360, height: 850 })
    assert.equal(await page.locator('.model-group.compact').count(), 0, 'Widening restores full controls')
    const disclosure = page.locator('.steps-toggle').last()
    await disclosure.click()
    await settle(page)
    assert(await page.locator('.steps-fold').last().evaluate(el => el.getBoundingClientRect().height > 20))
    await disclosure.click()
    assert(await page.locator('.steps-fold').last().evaluate(el => el.inert), 'Closing content becomes noninteractive immediately')
    await page.locator('.steps-fold').waitFor({ state: 'detached' })
    await page.locator('.side-pane-toggle').click()
    await page.locator('.files-pane').getByText('README.md', { exact: true }).waitFor()
    await capture(code, page, `code-${theme}-workspace`)
    await page.locator('.side-pane-toggle').click()
    await page.locator('.sidebar [aria-label="设置"]').click()
    await opaque(page, '.modal')
    await capture(code, page, `code-${theme}-settings`)
    await page.keyboard.press('Escape')
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('.steps-toggle').last().click()
  await page.locator('.steps-fold').waitFor()
  await page.locator('.steps-toggle').last().click()
  await page.locator('.steps-fold').waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  assert(await code.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log('PASS Code: opaque animated menus/dialogs; light/dark at 1360/860/640px; full-control restoration; bounded disclosure and reduced motion')
} finally { await code.close() }

const botRoot = process.argv[2] && resolve(process.argv[2])
if (botRoot) {
  const botData = mkdtempSync(join(tmpdir(), 'fenn-material-bot-'))
  writeFileSync(join(botData, 'backends.json'), JSON.stringify([{ id: 'fixture', name: '本地测试后端', command: process.execPath, args: [join(botRoot, 'resources/fenn/mock-agent.mjs')] }]))
  writeFileSync(join(botData, 'state.json'), JSON.stringify({
    bots: [{ id: 'main', name: 'Fenn', instructions: '', backendId: 'fixture', status: 'idle', messages: messages.filter(m => !['u0', 'a0'].includes(m.id)).map(m => ({ id: m.id, role: m.role, at: m.createdAt, blocks: m.blocks.filter(b => b.type === 'text').map(b => ({ kind: 'text', text: b.text })) })) }],
    config: { theme: 'light', browserMode: 'isolated', computerEnabled: false }, backendSettings: {}
  }))
  const bot = await electron.launch({ cwd: botRoot, args: ['.'], env: { ...process.env, FENN_BOT_DATA: botData, FENN_BOT_BACKGROUND: '1', FENN_BOT_TEST: '1' } })
  try {
    const page = await bot.firstWindow(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.locator('.bot-app').waitFor()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.bot.configure({ theme }), theme)
      await bot.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 850))
      await settle(page)
      await nodeClearance(page, 'bot')
      await page.locator('.input-action').click()
      await opaque(page, '.input-menu')
      await capture(bot, page, `bot-${theme}-menu`)
      await page.getByRole('menuitem', { name: '模型与后端', exact: true }).click()
      await page.getByRole('dialog', { name: '模型与后端', exact: true }).waitFor()
      await page.evaluate(() => {
        const dialog = document.querySelector('.bot-dialog')
        for (const animation of dialog.getAnimations()) {
          animation.pause()
          animation.currentTime = Number(animation.effect.getTiming().duration) * .2
        }
        document.querySelector('[role=combobox][aria-label="Agent 后端"]').click()
      })
      await page.locator('.select-list:popover-open').waitFor()
      const anchored = await page.evaluate(async () => {
        const dialog = document.querySelector('.bot-dialog')
        document.querySelector('.select-list:popover-open').getAnimations().forEach(animation => animation.finish())
        for (const animation of dialog.getAnimations()) animation.currentTime = Number(animation.effect.getTiming().duration) * .8
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const anchor = document.querySelector('[role=combobox][aria-label="Agent 后端"]').getBoundingClientRect()
        const menu = document.querySelector('.select-list:popover-open').getBoundingClientRect()
        const gap = Math.min(Math.abs(menu.top - anchor.bottom - 5), Math.abs(anchor.top - menu.bottom - 5))
        dialog.getAnimations().forEach(animation => animation.finish())
        return { gap, left: Math.abs(menu.left - anchor.left) }
      })
      assert(anchored.gap < 1 && anchored.left < 1, `Bot selector follows the moving dialog: ${JSON.stringify(anchored)}`)
      await page.keyboard.press('Escape')
      await capture(bot, page, `bot-${theme}-runtime`)
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.getByRole('button', { name: '查看 Bot 详情', exact: true }).click()
      await page.locator('.task-inspector').waitFor()
      await capture(bot, page, `bot-${theme}-workspace`)
      await page.getByRole('button', { name: '收起侧面板', exact: true }).click()
      await page.locator('.task-inspector').waitFor({ state: 'detached' })
    }
    assert.deepEqual(errors, [])
    assert(await bot.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
    console.log('PASS Bot: opaque popovers, shared surfaces and controls; docked inspector preserved; both themes')
  } finally { await bot.close() }
}
console.log('MATERIAL_SHOTS', shots)
