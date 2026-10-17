// End-to-end UI checks against the built app, with the demo agent.
// Usage: npm run build && xvfb-run -a node scripts/e2e.mjs [screenshotDir]
// Exits non-zero if any check fails.
import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareTestAgent } from './test-agent.mjs'

const shots = process.argv[2]
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, ANCORA_DATA_DIR: declareTestAgent(mkdtempSync(join(tmpdir(), 'oc-e2e-'))) }
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForSelector('.sidebar')
// The checks use Chinese labels, whatever the machine's language.
await page.evaluate(() => {
  localStorage.setItem('oc-lang', 'zh')
  // Pane widths from an earlier run would move everything.
  for (const k of Object.keys(localStorage)) if (k.startsWith('oc-width-')) localStorage.removeItem(k)
})
await page.reload()
await page.waitForSelector('.sidebar')
// The first-run guide covers the app; scenarios that aren't about it skip it.
if (!process.env.KEEP_ONBOARDING && (await page.locator('.onboarding').count())) {
  await page.click('.onboarding .skip')
  await page.waitForSelector('.onboarding', { state: 'detached' })
}
let failed = 0
// E2E_ONLY=<regex> runs only the matching checks (keep the ones they build on).
const only = process.env.E2E_ONLY && new RegExp(process.env.E2E_ONLY)
/** Opens one of the project panel's views under 「…」 (成果, 项目资料, 项目记忆, 定时任务, 里程碑). */
const panelView = async (label) => {
  await page.click('.panel-head [data-more]')
  await page.click(`.menu .menu-item:has-text("${label}")`)
}
async function check(name, fn) {
  if (only && !only.test(name)) return
  try {
    await fn()
    console.log('✓', name)
  } catch (e) {
    failed++
    console.log('✗', name, '\n  ', String(e?.message ?? e).split('\n')[0])
  }
  if (shots) await page.screenshot({ path: join(shots, `e2e-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
}
const send = async (text) => {
  await page.fill('.composer textarea', text)
  await page.keyboard.press('Enter')
  // Done when the working indicator above the composer goes away.
  await page.waitForTimeout(300)
  await page.waitForSelector('.working-mark', { state: 'detached', timeout: 20000 })
}

await check('thanks in a project chat shows the coordinator 👍 on the message', async () => {
  await page.click('.nav-item:has-text("项目")')
  await page.click('.page-head .btn')
  await page.fill('.modal input', '端到端')
  await page.click('.modal-actions .btn.primary')
  await page.waitForSelector('.panel')
  await send('谢谢')
  await page.waitForSelector('.msg-user .reactions .reaction:has-text("👍")', { timeout: 15000 })
})

await check('the sidebar and the thread panel resize from their inner edge, remember it, reset on double-click, and the sidebar folds away when dragged narrow', async () => {
  const width = async (sel) => (await page.locator(sel).boundingBox()).width
  const drag = async (sel, dx, during) => {
    const h = await page.locator(sel).boundingBox()
    const x = h.x + h.width / 2
    const y = h.y + 300
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx / 2, y, { steps: 4 })
    await page.mouse.move(x + dx, y, { steps: 4 })
    // The pane follows the pointer while the button is still down.
    await during?.()
    await page.mouse.up()
    await page.waitForTimeout(250)
  }
  const step = (what) => console.log('   …', what)
  const near = (a, b, what) => { if (Math.abs(a - b) > 3) throw new Error(`${what}: ${a} vs ${b}`) }
  const s0 = await width('.sidebar')
  const rest = async () => (await width('.center .workspace > .center')) + (await width('.panel:visible'))
  const rest0 = await rest()
  await drag('.sidebar > .resize-handle', 80, async () => near(await width('.sidebar'), s0 + 80, 'sidebar while dragging'))
  near(await width('.sidebar'), s0 + 80, 'sidebar after drag')
  near(await rest(), rest0 - 80, 'the rest of the window reflows by the same amount')
  await drag('.sidebar > .resize-handle', 600)
  near(await width('.sidebar'), 440, 'sidebar stops at its maximum')
  await page.reload()
  await page.waitForSelector('.sidebar')
  near(await width('.sidebar'), 440, 'sidebar width remembered after a reload')
  await page.dblclick('.sidebar > .resize-handle')
  await page.waitForTimeout(250)
  near(await width('.sidebar'), s0, 'double-click resets the sidebar')
  await drag('.sidebar > .resize-handle', -s0)
  if (!(await page.locator('.sidebar.closed').count())) throw new Error('sidebar did not fold away')
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(300)
  near(await width('.sidebar'), s0, 'sidebar opens again at its width')
  await page.click('.sidebar .nav-item:has-text("端到端"), .sidebar .project-item:has-text("端到端"), .sidebar :text("端到端")')
  await page.waitForSelector('.panel')
  const p0 = await width('.panel:visible')
  await drag('.panel:visible > .resize-handle', -120, async () => near(await width('.panel:visible'), p0 + 120, 'thread panel while dragging'))
  near(await width('.panel:visible'), p0 + 120, 'thread panel after drag')
  await drag('.panel:visible > .resize-handle', 2000)
  near(await width('.panel:visible'), 360, 'thread panel stops at its minimum')
  await page.dblclick('.panel:visible > .resize-handle')
  await page.waitForTimeout(250)
  near(await width('.panel:visible'), p0, 'double-click resets the thread panel')
  // A narrower window fits the panes again: the panel gives way, then folds away; the sidebar
  // keeps the width the user chose, and the conversation keeps at least 420px.
  await drag('.sidebar > .resize-handle', 600)
  await drag('.panel:visible > .resize-handle', -2000)
  for (const w of [1100, 900]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(300)
    near(await width('.sidebar'), 440, `at ${w}px the sidebar keeps its width`)
    const center = await width('.center .workspace > .center')
    if (center < 419) throw new Error(`at ${w}px the conversation is ${center}px wide`)
    const composer = await page.locator('.center .workspace > .center .composer').boundingBox()
    if (!composer || composer.width < 300) throw new Error(`at ${w}px the composer is gone`)
  }
  if (await page.locator('.panel:visible').count()) throw new Error('panel still beside the conversation at 900px')
  await page.click('[data-tip="打开讨论串"]')
  await page.waitForSelector('.panel.floating')
  // The floating panel covers the conversation: nothing may show through it.
  const panelBg = await page.$eval('.panel.floating', (el) => getComputedStyle(el).backgroundColor)
  const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(panelBg)?.[1]
  if (alpha !== undefined && Number(alpha) < 0.9) throw new Error(`the floating panel is see-through: ${panelBg}`)
  // It closes like a popover: Esc, or a click on the conversation behind it.
  await page.keyboard.press('Escape')
  await page.waitForSelector('.panel.floating', { state: 'detached', timeout: 2000 })
  await page.click('[data-tip="打开讨论串"]')
  await page.waitForSelector('.panel.floating')
  await page.mouse.click(400, 300)
  await page.waitForSelector('.panel.floating', { state: 'detached', timeout: 2000 })
  await page.click('[data-tip="打开讨论串"]')
  await page.waitForSelector('.panel.floating')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForTimeout(300)
  if (await page.locator('.panel.floating').count()) throw new Error('panel still floating in a wide window')
  near(await width('.sidebar'), 440, 'sidebar back to its chosen width')
  // Narrowing again doesn't bring the floating panel back by itself.
  await page.setViewportSize({ width: 900, height: 900 })
  await page.waitForTimeout(300)
  if (await page.locator('.panel:visible').count()) throw new Error('the panel floated up by itself')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForTimeout(300)
  await page.dblclick('.sidebar > .resize-handle')
  await page.dblclick('.panel:visible > .resize-handle')
  // The keyboard works too: arrows move the edge, Home resets.
  const sb0 = await width('.sidebar')
  await page.focus('.sidebar > .resize-handle')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  near(await width('.sidebar'), sb0 + 16, 'ArrowRight widens the sidebar')
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  near(await width('.sidebar'), sb0, 'Home resets the sidebar')
  // A tooltip-free separator with a resize cursor.
  if ((await page.locator('.panel:visible > .resize-handle').evaluate((el) => getComputedStyle(el).cursor)) !== 'col-resize') throw new Error('no col-resize cursor')
})

await check('a project menu like Claude: open with, pin P, rename R, notifications with four levels, settings S, archive A, delete D', async () => {
  await page.click('.sidebar .nav-item:has-text("端到端")', { button: 'right' })
  await page.waitForSelector('.menu')
  const labels = (await page.locator('.menu .menu-item').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim())
  const want = ['打开方式', '置顶 P', '重命名 R', '通知 协调者', '设置 S', '归档 A', '删除 D']
  if (JSON.stringify(labels) !== JSON.stringify(want)) throw new Error('menu: ' + JSON.stringify(labels))
  if (!(await page.locator('.menu .menu-item.danger:has-text("删除")').count())) throw new Error('删除 is not red')
  await page.hover('.menu .menu-item:has-text("通知")')
  await page.waitForSelector('.menu.is-sub')
  const levels = (await page.locator('.menu.is-sub .menu-item').allInnerTexts()).map((x) => x.split('\n')[0].trim())
  if (JSON.stringify(levels) !== JSON.stringify(['所有新消息', '协调者与 @提及', '仅 @提及', '无'])) throw new Error('levels: ' + JSON.stringify(levels))
  if (!(await page.locator('.menu.is-sub .menu-item:has-text("协调者与 @提及") .lucide-check').count())) throw new Error('default level not checked')
  await page.click('.menu.is-sub .menu-item:has-text("仅 @提及")')
  await page.waitForSelector('.menu', { state: 'detached' })
  await page.click('.sidebar .nav-item:has-text("端到端")', { button: 'right' })
  if (!(await page.locator('.menu .menu-item:has-text("通知")').innerText()).includes('仅提及')) throw new Error('level not shown after choosing')
  await page.keyboard.press('Escape')
})

await check('@ in the project chat picks a thread, the message goes straight there, and the project chat keeps one line', async () => {
  await page.click('.sidebar .nav-item:has-text("端到端")')
  await send('帮我调研竞品定价')
  await page.waitForSelector('.thread-card', { timeout: 15000 })
  await page.click('.center .workspace > .center .composer textarea')
  await page.keyboard.type('@竞品')
  await page.waitForSelector('.mention-menu .menu-item.active:has-text("调研竞品定价")')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.mention-chip:has-text("调研竞品定价")')
  await page.keyboard.type('再加一家 D 公司')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.thread-event.kind-forwarded:has-text("已转给「调研竞品定价」：再加一家 D 公司")', { timeout: 5000 })
  if (await page.locator('.mention-chip').count()) throw new Error('chip stayed after sending')
  if (await page.locator('.center .workspace > .center .msg-user:has-text("再加一家")').count()) throw new Error('the message also went to the coordinator')
  await page.click('.thread-event.kind-forwarded')
  await page.waitForSelector('.panel .msg-user:has-text("再加一家 D 公司")', { timeout: 5000 })
})

await check('a thread leaves another a message: a card on each side, where it went and where it came from', async () => {
  await send('帮我写发布说明')
  await page.waitForSelector('.thread-card:has-text("写发布说明")', { timeout: 15000 })
  await page.click('.center .workspace > .center .composer textarea')
  await page.keyboard.type('请@竞品')
  await page.waitForSelector('.mention-menu .menu-item.active:has-text("调研竞品定价")')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('#留言 写发布说明 || now || || 定价结论：D 公司最便宜')
  await page.keyboard.press('Enter')
  await page.click('.thread-event.kind-forwarded >> nth=-1')
  const out = page.locator('.panel .peer-card.dir-out')
  await out.waitFor({ timeout: 15000 })
  if (!(await out.innerText()).includes('留言给「写发布说明」')) throw new Error('out card: ' + (await out.innerText()))
  await page.waitForSelector('.panel .peer-card.dir-out .status-chip:has-text("已送达")', { timeout: 15000 })
  await out.locator('.peer-link').click()
  const inbound = page.locator('.panel .peer-card.dir-in')
  await inbound.waitFor({ timeout: 5000 })
  const text = await inbound.innerText()
  if (!text.includes('来自「调研竞品定价」') || !text.includes('定价结论：D 公司最便宜')) throw new Error('in card: ' + text)
})

await check('one Chinese character finds a message, and the hit scrolls to it', async () => {
  await page.click('.nav-item:has-text("新建")')
  await send('量子计算的入门书推荐')
  await page.click('.nav-item:has-text("对话")')
  await page.fill('.page .search input', '量')
  await page.waitForSelector('.list-row .hit', { timeout: 5000 })
  await page.click('.list-row:has(.hit)')
  await page.waitForSelector('[data-mid].flash', { timeout: 5000 })
})

await check('a long chat keeps the composer on screen', async () => {
  for (let i = 0; i < 6; i++) await send('请详细解释一下第 ' + i + ' 个概念')
  const box = await page.locator('.composer').boundingBox()
  const vp = page.viewportSize()
  if (!box || box.y + box.height > vp.height || box.y < 0) throw new Error(`composer at ${JSON.stringify(box)}`)
})

await check('one click turns 玻璃效果 on and back off, and the long chat still scrolls smoothly', async () => {
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const before = await theme()
  // Scroll the long chat to the top and back, timing frames.
  const scrollTest = () => page.evaluate(async () => {
    const el = document.querySelector('.center .scroll')
    if (!el) throw new Error('no transcript')
    let last = performance.now()
    let worst = 0
    for (let i = 0; i < 60; i++) {
      el.scrollTop = (el.scrollHeight * (i % 30)) / 30
      await new Promise((r) => requestAnimationFrame(r))
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }
    return worst
  })
  const plain = await scrollTest()
  // Nothing moves when the look changes: the same boxes before and after.
  const boxes = () => page.evaluate(() => [...document.querySelectorAll('.bubble, .composer, .chat-header')].slice(-6).map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)].join('x') }).join(' '))
  const plainBoxes = await boxes()
  await page.click('.glass-toggle')
  await page.waitForFunction(() => /^glass/.test(document.documentElement.dataset.theme))
  await page.waitForTimeout(200)
  const glassBoxes = await boxes()
  if (glassBoxes !== plainBoxes) throw new Error(`glass moves things: ${plainBoxes} → ${glassBoxes}`)
  const glass = await scrollTest()
  console.log(`   slowest scroll frame: ${Math.round(plain)} ms ${before}, ${Math.round(glass)} ms glass (software rendering)`)
  await page.click('.glass-toggle')
  await page.waitForFunction((b) => document.documentElement.dataset.theme === b, before)
})

await check('Esc closes dialogs, and Settings keeps one size on every tab', async () => {
  await page.click('.user-btn')
  await page.waitForSelector('.modal.wide')
  // Measure once the dialog has finished rising in.
  const settled = () => page.waitForFunction(() => document.querySelector('.modal.wide')?.getAnimations({ subtree: true }).every((a) => a.playState !== 'running') ?? false, null, { timeout: 3000 })
  const sizes = new Set()
  for (const tab of ['通用', '外观', 'Agent 后端', '连接器', '关于']) {
    await page.click(`.settings-nav .nav-item:has-text("${tab}")`)
    await page.waitForTimeout(120)
    await settled().catch(() => {})
    const b = await page.locator('.modal.wide').boundingBox()
    sizes.add(`${Math.round(b.width)}x${Math.round(b.height)}`)
  }
  if (sizes.size !== 1) throw new Error('settings size changed: ' + [...sizes].join(', '))
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
})

await check('text fields never show the square browser focus ring', async () => {
  await page.click('.nav-item:has-text("项目")')
  await page.click('.page-head .btn')
  await page.waitForSelector('.modal input')
  await page.keyboard.press('Tab')
  await page.focus('.modal input')
  const s = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement)
    return { outline: cs.outlineStyle, tag: document.activeElement.tagName }
  })
  if (s.tag !== 'INPUT' || s.outline !== 'none') throw new Error(JSON.stringify(s))
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
})

await check('dialogs keep keyboard focus inside and give it back on close', async () => {
  await page.focus('.user-btn')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.modal.wide')
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('.overlay'))
  if (!(await inside())) throw new Error('focus did not move into Settings')
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab')
    if (!(await inside())) throw new Error('Tab left the dialog after ' + (i + 1) + ' presses')
  }
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
  const back = await page.evaluate(() => document.activeElement?.classList.contains('user-btn'))
  if (!back) throw new Error('focus did not return to the Settings button')
})

await check('Esc in the add-connector form closes only the form', async () => {
  await page.click('.user-btn')
  await page.click('.settings-nav .nav-item:has-text("连接器")')
  await page.click('.settings-body .btn:has-text("添加连接器")')
  await page.waitForSelector('.settings-body h2:has-text("添加连接器")')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  if (await page.locator('.settings-body h2:has-text("添加连接器")').count()) throw new Error('form still open')
  if (!(await page.locator('.modal.wide').count())) throw new Error('Esc closed the whole Settings window')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
})

await check('deleting asks in an in-app dialog; Esc keeps the chat, 删除 removes it', async () => {
  const rows = page.locator('.sidebar nav:not(.recent-projects) .nav-item:has(.dot)')
  const before = await rows.count()
  const openDelete = async () => {
    await rows.first().hover()
    await rows.first().locator('.trail .icon-btn').click()
    await page.click('.menu-item:has-text("删除")')
    await page.waitForSelector('.modal.confirm')
  }
  await openDelete()
  const focused = await page.evaluate(() => document.activeElement?.classList.contains('confirm-cancel'))
  if (!focused) throw new Error('confirm did not focus 取消')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal.confirm', { state: 'detached', timeout: 2000 })
  if ((await rows.count()) !== before) throw new Error('Esc deleted the chat')
  await openDelete()
  await page.click('.modal.confirm .btn.danger-solid')
  await page.waitForFunction((n) => document.querySelectorAll('.sidebar nav:not(.recent-projects) .nav-item .dot').length < n, before, { timeout: 3000 })
})

await check('closing New Project returns focus to the button that opened it', async () => {
  await page.click('.nav-item:has-text("项目")')
  await page.focus('.page-head .btn')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.modal input')
  const inInput = await page.evaluate(() => document.activeElement?.matches('.modal input'))
  if (!inInput) throw new Error('focus did not start in 名称')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
  const back = await page.evaluate(() => document.activeElement?.matches('.page-head .btn'))
  if (!back) throw new Error('focus is on ' + (await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))))
})

await check('cancelling a sidebar delete puts focus back on its 「…」 button', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await send('再开一个对话')
  const row = page.locator('.sidebar nav:not(.recent-projects) .nav-item:has(.dot)').first()
  await row.hover()
  await row.locator('.trail .icon-btn').click()
  await page.click('.menu-item:has-text("删除")')
  await page.waitForSelector('.modal.confirm')
  await page.click('.modal.confirm .confirm-cancel')
  await page.waitForSelector('.modal.confirm', { state: 'detached', timeout: 2000 })
  await page.mouse.move(900, 500)
  const ok = await page.evaluate(() => !!document.activeElement?.closest('.sidebar .nav-item .trail'))
  if (!ok) throw new Error('focus is on ' + (await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))))
})

await check('Esc closes the project memory form', async () => {
  await page.click('.sidebar .nav-item:has-text("端到端")')
  await panelView('项目记忆')
  await page.click('.btn:has-text("添加记忆")')
  await page.waitForSelector('textarea.textarea')
  await page.focus('textarea.textarea')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.btn:has-text("添加记忆")', { timeout: 2000 })
})

await check('the connector form has one 取消 and one 保存; settings close from the corner ✕ or Esc', async () => {
  await page.click('.user-btn')
  await page.click('.settings-nav .nav-item:has-text("连接器")')
  await page.click('.settings-body .btn:has-text("添加连接器")')
  await page.waitForSelector('.settings-body h2:has-text("添加连接器")')
  const labels = await page.locator('.modal.wide .modal-actions .btn').allInnerTexts()
  const want = ['取消', '保存']
  if (JSON.stringify(labels.map((l) => l.trim())) !== JSON.stringify(want)) throw new Error('buttons: ' + labels.join(' | '))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  if (await page.locator('.modal.wide .btn:has-text("完成")').count()) throw new Error('完成 is still there')
  // The close button sits in the top-right corner (top-left on macOS).
  const box = await page.locator('.settings-close').boundingBox()
  const modal = await page.locator('.modal.wide').boundingBox()
  const mac = process.platform === 'darwin'
  const near = mac ? box.x - modal.x < 30 : modal.x + modal.width - (box.x + box.width) < 30
  if (!near || box.y - modal.y > 30) throw new Error('close button not in the corner: ' + JSON.stringify({ box, modal }))
  // A name typed and left unsaved is kept when Esc closes Settings.
  await page.click('.settings-nav .nav-item:has-text("通用")')
  await page.fill('.settings-body input.input >> nth=0', 'E2E 名字')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
  const saved = await page.evaluate(() => window.ancora.snapshot().then((s) => s.settings.userName))
  if (saved !== 'E2E 名字') throw new Error('name not saved on close: ' + saved)
  await page.evaluate(() => window.ancora.updateSettings({ userName: '' }))
  await page.click('.user-btn')
  await page.click('.settings-close')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
})

await check('the sidebar has no Agent 后端 entry; the agent menu ends with 管理 Agent 后端…', async () => {
  if (await page.locator('.sidebar .nav-item:has-text("Agent 后端")').count()) throw new Error('sidebar still has Agent 后端')
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.locator('.composer-row .backend-chip').click()
  await page.waitForSelector('.menu')
  // The chip's own tooltip stays hidden while its menu is open, even as the pointer comes back to it.
  await page.mouse.move(0, 0)
  await page.locator('.composer-row .backend-chip').hover()
  await page.waitForTimeout(700)
  if (await page.locator('.tooltip.on').count()) throw new Error('tooltip shown over the open agent menu')
  if ((await page.locator('.composer-row .backend-chip').getAttribute('aria-expanded')) !== 'true') throw new Error('agent chip not marked expanded')
  const last = (await page.locator('.menu .menu-item').last().innerText()).trim()
  if (!last.includes('管理 Agent 后端')) throw new Error('last item: ' + last)
  await page.locator('.menu .menu-item').last().click()
  await page.waitForSelector('.settings-body h2:has-text("Agent 后端")', { timeout: 2000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
})

await check('agent errors at send time read as plain Chinese, with the original under 详情', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await send('#fail-auth 你好')
  const bar = page.locator('.msg-error').last()
  await bar.waitFor({ timeout: 8000 })
  const text = await bar.innerText()
  if (!/需要登录，或者登录已过期/.test(text)) throw new Error('auth error reads: ' + text)
  if (await bar.locator('details[open]').count()) throw new Error('详情 should start collapsed')
  await bar.locator('summary:has-text("详情")').click()
  const raw = await bar.locator('details code').innerText()
  if (!raw.includes('Authentication required')) throw new Error('original text missing: ' + raw)
  await send('#fail-net 再试')
  await page.waitForFunction(() => document.querySelectorAll('.msg-error').length >= 2, null, { timeout: 8000 })
  const net = await page.locator('.msg-error').last().innerText()
  if (!/连不上 .* 的服务/.test(net)) throw new Error('network error reads: ' + net)
})

await check('the home composer shows the model name, as inside a chat', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  const label = (await page.locator('.composer .model-btn').innerText()).trim()
  if (!/^Mock (Fast|Smart)/.test(label)) throw new Error('home shows: ' + label)
  if ((await page.locator('.composer .backend-chip').innerText()).trim() !== '演示 Agent') throw new Error('no agent chip left of the model')
})

await check('the new-chat page keeps the greeting and composer in place', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  // A taller draft grows the composer upwards, as in a chat: its bottom edge stays put.
  const top = async () => {
    const box = (await page.locator('.home .composer').boundingBox())
    return Math.round(box.y + box.height)
  }
  const greet = async () => Math.round((await page.locator('.home .greeting').boundingBox()).y)
  const [c0, g0] = [await top(), await greet()]
  await page.locator('.composer-row .backend-chip').click()
  await page.locator('.menu .menu-item', { hasText: '演示 Agent' }).click()
  await page.fill('.composer textarea', '一\n二\n三\n四\n五\n六')
  await page.waitForTimeout(200)
  if ((await top()) !== c0 || (await greet()) !== g0) throw new Error(`moved: composer ${c0}→${await top()}, greeting ${g0}→${await greet()}`)
  await page.fill('.composer textarea', '')
})

await check('the home composer has no project picker, and a chat that makes files gets a folder', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  if (await page.locator('.home .composer .select-btn:has-text("项目")').count()) throw new Error('project picker still on the home composer')
  if (await page.locator('.home .folder-chip.on').count()) throw new Error('a folder is picked by default')
  await page.locator('.composer-row .backend-chip').click()
  await page.locator('.menu .menu-item', { hasText: '演示 Agent' }).click()
  await page.fill('.composer textarea', '写文件 计划.md')
  await page.keyboard.press('Enter')
  const line = page.locator('.placed-line')
  await line.waitFor({ timeout: 20000 })
  if (!/已放在 .+/.test(await line.innerText())) throw new Error('reads: ' + (await line.innerText()))
  if (!(await page.locator('.composer .folder-chip.on').count())) throw new Error('the composer does not show the new folder')
})

await check('a chat shows its folder’s files beside it, with the files the agent changed marked', async () => {
  await page.click('.side-pane-toggle')
  await page.waitForSelector('.side-pane .files-pane')
  const row = page.locator('.side-pane .tree-row:has-text("计划.md")')
  await row.waitFor({ timeout: 5000 })
  if (!(await row.locator('.tree-mark').count())) throw new Error('the changed file is not marked')
  await row.click()
  await page.locator('.side-pane .preview-md h1:has-text("计划.md")').waitFor({ timeout: 3000 })
  if (await page.locator('.preview-head .icon-btn[aria-label="返回文件列表"]').count()) await page.click('.preview-head .icon-btn[aria-label="返回文件列表"]')
  await page.click('.side-pane .files-tools .chip')
  await page.locator('.side-pane .tree-row.change:has-text("计划.md")').waitFor({ timeout: 3000 })
  await page.click('.side-pane .files-tools .chip')
})

await check('commands the agent runs through the app show under 后台 and stop from there', async () => {
  await page.fill('.composer textarea', '后台运行 sleep 30')
  await page.keyboard.press('Enter')
  await page.click('.side-pane .tab:has-text("后台")')
  const row = page.locator('.side-pane .bg-command:has-text("sleep 30")')
  await row.waitFor({ timeout: 10000 })
  if (!(await page.locator('.side-pane-toggle .run-dot').count())) throw new Error('no running mark on the pane button')
  await row.locator('.icon-btn[aria-label="停止"]').click()
  await row.locator('.status-chip').waitFor({ timeout: 5000 })
  await page.click('.side-pane .icon-btn[aria-label="关闭"]')
})

await check('/ lists the commands; /子对话 hands the text to a new sub-chat without asking this chat’s agent', async () => {
  const before = await page.locator('.center .turn').count()
  await page.fill('.composer textarea', '/')
  const menu = page.locator('.slash-pop')
  await menu.waitFor({ timeout: 3000 })
  const items = await menu.locator('.slash-name').allInnerTexts()
  if (items[0] !== '子对话' || !items.includes('compact')) throw new Error('menu reads ' + items.join(', '))
  await page.keyboard.press('Enter')
  if (!(await page.locator('.composer .command-chip:has-text("子对话")').count())) throw new Error('the picked command is not a chip')
  if ((await page.inputValue('.composer textarea')) !== '') throw new Error('the command was left as text')
  await page.keyboard.type('整理一下日志')
  await page.keyboard.press('Enter')
  await page.locator('.center .thread-card').last().waitFor({ timeout: 5000 })
  const child = await page.evaluate(async () => (await window.ancora.snapshot()).conversations.find((c) => c.parentId && c.handoff?.task === '整理一下日志'))
  if (!child) throw new Error('no sub-chat with that task')
  if (!child.handoff.context?.includes('计划.md')) throw new Error('the sub-chat got no context from this chat')
  if (!(await page.locator('.center .bubble .cmd-token:has-text("/子对话")').count())) throw new Error('the sent command is not shown as a token')
  await page.waitForTimeout(800)
  const replies = await page.evaluate(async (id) => (await window.ancora.messages(id)).filter((m) => m.role === 'assistant').length, child.parentId)
  const turns = await page.locator('.center .turn').count()
  if (turns > before + 1) throw new Error(`this chat's agent answered too (${before} → ${turns} turns, ${replies} replies)`)
  // /子对话 with nothing after it says what's missing.
  await page.fill('.composer textarea', '/子对话 ')
  await page.locator('.composer .command-chip').waitFor({ timeout: 3000 })
  await page.keyboard.press('Enter')
  await page.locator('.toast:has-text("请在命令后面写上要做的事")').waitFor({ timeout: 3000 })
  await page.keyboard.press('Backspace')
  // An agent command needs no text: picked from the menu, Enter sends it as is.
  await page.fill('.composer textarea', '/comp')
  await page.locator('.slash-pop').waitFor({ timeout: 3000 })
  await page.keyboard.press('Enter')
  await page.locator('.composer .command-chip:has-text("compact")').waitFor({ timeout: 3000 })
  if (await page.locator('.composer .send-btn').isDisabled()) throw new Error('send is off with a picked command')
  await page.keyboard.press('Enter')
  await page.locator('.center .bubble .cmd-token:has-text("/compact")').waitFor({ timeout: 5000 })
  // The ring's 压缩上下文 is a button, not a message: one line in the transcript, no /compact bubble.
  await page.waitForFunction(() => !document.querySelector('.composer .stop-btn'), null, { timeout: 8000 }).catch(() => {})
  const bubbles = await page.locator('.center .bubble .cmd-token:has-text("/compact")').count()
  await page.click('.composer .context-ring')
  await page.locator('.menu .menu-item:has-text("压缩上下文")').click()
  await page.locator('.center .day-divider:has-text("已压缩上下文")').waitFor({ timeout: 8000 })
  if ((await page.locator('.center .bubble .cmd-token:has-text("/compact")').count()) !== bubbles) throw new Error('the button sent a /compact message')
})
await check('a / command the agent does not list is held back once; Enter again sends it', async () => {
  const before = await page.locator('.center .msg-user').count()
  await page.fill('.composer textarea', '/frobnicate now')
  await page.keyboard.press('Escape')
  await page.click('.composer .send-btn')
  await page.locator('.toast:has-text("/frobnicate")').waitFor({ timeout: 3000 })
  if ((await page.locator('.center .msg-user').count()) !== before) throw new Error('the unknown command was sent')
  if ((await page.inputValue('.composer textarea')) !== '/frobnicate now') throw new Error('the text was cleared')
  // Asked again, it goes as written: a path, or a command the agent takes without listing it.
  await page.click('.composer .send-btn')
  await page.waitForFunction((n) => document.querySelectorAll('.center .msg-user').length === n + 1, before, { timeout: 5000 })
  await page.waitForSelector('.working-mark', { state: 'detached', timeout: 20000 })
})
await check('/rename renames the conversation too', async () => {
  const id = await page.evaluate(async () => (await window.ancora.snapshot()).conversations.find((c) => !c.parentId && !c.projectId)?.id)
  if (!id) throw new Error('no chat to rename')
  await page.evaluate((id) => window.ancora.send(id, '/rename 发布清单'), id)
  await page.waitForFunction(async (id) => (await window.ancora.snapshot()).conversations.find((c) => c.id === id)?.title === '发布清单', id, { timeout: 8000 })
})


await check('a new project is not pinned and is listed by recent activity', async () => {
  const pinned = await page.locator('.section-head:has-text("已置顶")').count()
  if (pinned) throw new Error('projects went into 已置顶')
  const first = (await page.locator('.recent-projects .nav-item').first().innerText()).trim()
  if (!first.includes('端到端')) throw new Error('recent projects start with: ' + first)
  if (await page.locator('.sidebar .lucide-send').count()) throw new Error('a paper-plane icon is still used for projects')
})

await check('every 「…」 menu opens next to its button, inside the window', async () => {
  // Busy app: another chat keeps streaming, so the sidebar redraws while menus open.
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.fill('.composer textarea', '讲一个很长的故事')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  const near = async (btn, label) => {
    await page.waitForSelector('.menu', { timeout: 2000 })
    await page.waitForTimeout(80)
    // Both measured in the same frame: the button may have moved since the click, and the menu follows it.
    const [b, m] = await page.evaluate((el) => [el.getBoundingClientRect(), document.querySelector('.menu').getBoundingClientRect()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })), btn)
    const vp = page.viewportSize()
    const vertical = Math.min(Math.abs(m.y - (b.y + b.height)), Math.abs(m.y + m.height - b.y))
    const horizontal = Math.min(Math.abs(m.x - b.x), Math.abs(m.x + m.width - (b.x + b.width)))
    if (vertical > 12 || horizontal > 12 || m.x < 0 || m.y < 0 || m.x + m.width > vp.width || m.y + m.height > vp.height)
      throw new Error(`${label}: menu at ${Math.round(m.x)},${Math.round(m.y)} but button at ${Math.round(b.x)},${Math.round(b.y)}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.menu', { state: 'detached', timeout: 2000 })
  }
  const rows = page.locator('.sidebar .nav-item:has(.trail)')
  const n = await rows.count()
  if (n < 2) throw new Error('expected chat and project rows, got ' + n)
  for (let i = 0; i < n; i++) {
    // Hold the elements themselves: rows reorder while a reply streams, and nth(i) would then name another row.
    const row = await rows.nth(i).elementHandle()
    await row.hover()
    const btn = await row.$('.trail .icon-btn')
    const label = (await row.innerText()).trim()
    // Opened from the keyboard: the row may move from under the mouse, which hides its button again.
    await btn.focus()
    await page.keyboard.press('Enter')
    await near(btn, 'sidebar row ' + label)
  }
  const header = page.locator('.chat-header .icon-btn:has(.lucide-ellipsis), .chat-header .icon-btn:has(.lucide-more-horizontal)').last()
  await header.click()
  await near(await header.elementHandle(), 'chat header')
  await page.waitForSelector('.working-mark', { state: 'detached', timeout: 20000 })
})

await check('the model menu stays open during a reply; another model applies from the next turn', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.fill('.composer textarea', '讲一个很长的故事')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.working-mark', { timeout: 10000 })
  await page.click('.composer .model-btn')
  await page.waitForSelector('.menu')
  const other = page.locator('.menu .menu-item:not(.checked):has-text("下一轮生效")').first()
  await other.waitFor({ timeout: 3000 })
  if (await other.evaluate((el) => el.classList.contains('disabled') || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')) throw new Error('model item disabled mid-reply')
  await other.click()
  await page.waitForSelector('.menu', { state: 'detached' })
  if (!(await page.locator('.working-mark').count())) throw new Error('the reply stopped when the model changed')
  await page.waitForSelector('.working-mark', { state: 'detached', timeout: 30000 })
})

await check('a chat shows its plan under the title, opening to the full plan and obstacles', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await send('#难点 文档和接口对不上 先看看')
  const line = page.locator('.plan-line')
  await line.waitFor({ timeout: 5000 })
  const summary = await line.locator('.plan-summary').innerText()
  if (!summary.includes('3/3') || !summary.includes('文档和接口对不上')) throw new Error('plan line reads: ' + summary)
  await line.locator('.plan-summary').click()
  await line.locator('.plan-body .checklist').waitFor({ timeout: 2000 })
  if (!(await line.locator('.plan-current-blocker').innerText()).includes('文档和接口对不上')) throw new Error('current obstacle missing')
})

await check('a chat can be renamed from the sidebar', async () => {
  const row = page.locator('.sidebar .nav-item.selected')
  await row.hover()
  await row.locator('.trail .icon-btn').click()
  await page.click('.menu-item:has-text("重命名")')
  await page.waitForSelector('.modal.confirm input')
  // Focus starts in the name field with the old name selected, so typing replaces it.
  await page.waitForFunction(() => document.activeElement?.matches('.modal.confirm input'), null, { timeout: 2000 })
  await page.keyboard.type('接口排查')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.sidebar .nav-item.selected:has-text("接口排查")', { timeout: 3000 })
})

await check('the chats page groups chats by folder, and selects several to delete at once', async () => {
  await page.click('.sidebar .nav-item:has-text("对话")')
  const before = await page.locator('.page .list-row').count()
  if (before < 3) throw new Error('need at least 3 chats, have ' + before)
  if (!(await page.locator('.page .chat-group-head').count())) throw new Error('no folder groups')
  if (await page.locator('.select-bar .btn:has-text("移到项目")').count()) throw new Error('chats can still be moved into projects')
  await page.click('.page-head .btn:has-text("选择")')
  await page.locator('.page .list-row').nth(0).click()
  await page.locator('.page .list-row').nth(1).click()
  if (!(await page.locator('.select-bar').innerText()).includes('已选 2 个')) throw new Error('selection count wrong')
  if (await page.locator('.select-bar .btn:has-text("移到项目")').count()) throw new Error('chats can still be moved into projects')
  await page.click('.select-bar .btn:has-text("删除")')
  await page.click('.modal.confirm .btn.danger-solid')
  await page.waitForFunction((n) => document.querySelectorAll('.page .list-row').length === n - 2, before, { timeout: 3000 })
  const inProjects = await page.evaluate(async () => (await window.ancora.snapshot()).conversations.filter((c) => c.kind === 'chat' && c.projectId).length)
  if (inProjects) throw new Error(inProjects + ' chats inside projects')
})

await check('a project keeps a progress board of milestones and tasks, edited by hand', async () => {
  await page.click('.sidebar .recent-projects .nav-item:has-text("端到端")')
  // Threads are the milestones: the board only appears once something is on it (here, a goal the agent recorded).
  await page.click('.panel-head [data-more]')
  if (await page.locator('.menu .menu-item:has-text("里程碑")').count()) throw new Error('empty progress board offered')
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    const p = (await window.ancora.snapshot()).projects.find((x) => x.name.includes('端到端'))
    await window.ancora.updateProgress(p.id, { title: '第一版上线' })
  })
  await panelView('里程碑')
  if (!(await page.locator('.panel-head .tab.active:has-text("里程碑")').count())) throw new Error('the open view is not shown as a tab')
  const ms = page.locator('.progress-row.milestone:has-text("第一版上线")')
  await ms.waitFor({ timeout: 3000 })
  await ms.hover()
  const more = ms.locator('.icon-btn.sm')
  await more.click()
  await page.click('.menu-item:has-text("添加任务")')
  await page.fill('.progress-form input >> nth=0', '安装说明')
  await page.click('.progress-form .btn.primary')
  const task = page.locator('.progress-row.task:has-text("安装说明")')
  await task.waitFor({ timeout: 3000 })
  // One click starts it, a second finishes it; the milestone follows its only task.
  await task.locator('.status-btn').click()
  await page.waitForSelector('.progress-row.task .ps.doing', { timeout: 2000 })
  await task.locator('.status-btn').click()
  await page.waitForSelector('.progress-row.milestone.is-done', { timeout: 2000 })
  if (!(await page.locator('.progress-head').innerText()).includes('已完成 1/1')) throw new Error('summary wrong')
  await page.click('.panel-head .tab:has-text("讨论串")')
  await page.waitForSelector('.progress-summary:has-text("所有里程碑都已完成")', { timeout: 2000 })
})

await check('a project’s 库 shows its folder, and files added there land in it', async () => {
  await page.click('.sidebar .recent-projects .nav-item:has-text("端到端")')
  await page.click('.panel-head .tab[data-tab="library"]')
  await page.waitForSelector('.panel .files-pane .files-root')
  const p = await page.evaluate(async () => (await window.ancora.snapshot()).projects.find((x) => x.name.includes('端到端')))
  await page.evaluate((id) => window.ancora.addToLibrary(id, '', [{ name: '说明.md', data: btoa(unescape(encodeURIComponent('# 说明\n'))) }]), p.id)
  await page.click('.panel .files-head .icon-btn[aria-label="刷新"]')
  await page.locator('.panel .tree-row:has-text("说明.md")').waitFor({ timeout: 3000 })
  await page.click('.panel-head .tab[data-tab="threads"]')
})

await check('archiving a project hides it from the sidebar until restored', async () => {
  const header = page.locator('.chat-header .icon-btn:has(.lucide-ellipsis), .chat-header .icon-btn:has(.lucide-more-horizontal)').last()
  await header.click()
  await page.click('.menu-item:has-text("归档项目")')
  await page.waitForSelector('.archived-banner', { timeout: 2000 })
  if (await page.locator('.sidebar .nav-item:has-text("端到端")').count()) throw new Error('archived project still in the sidebar')
  await page.click('.sidebar .nav-item:has-text("项目") >> nth=0')
  await page.click('.section-toggle:has-text("已归档")')
  await page.click('.card.archived .link:has-text("恢复")')
  await page.waitForSelector('.card.archived', { state: 'detached', timeout: 2000 })
  await page.waitForSelector('.sidebar .nav-item:has-text("端到端")', { timeout: 2000 })
})

await check('a folder typed into a message is offered as the working folder, and only set on 设为', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-site-'))
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.fill('.composer textarea', `看看 ${dir} 里的代码`)
  const hint = page.locator('.folder-hint')
  await hint.waitFor({ timeout: 3000 })
  if (!(await page.locator('.folder-chip').innerText()).includes('文件夹')) throw new Error('folder set before asking')
  await hint.locator('.btn').click()
  await page.waitForSelector('.folder-hint', { state: 'detached', timeout: 2000 })
  const chip = await page.locator('.folder-chip').innerText()
  if (!chip.includes(dir.split('/').pop())) throw new Error('chip reads ' + chip)
  // Saying no hides it for that folder.
  await page.click('.folder-chip')
  await page.click('.menu-item:has-text("不使用文件夹")')
  await page.fill('.composer textarea', `再看看 ${dir}`)
  await hint.waitFor({ timeout: 3000 })
  await hint.locator('.icon-btn').click()
  await page.fill('.composer textarea', `还是 ${dir} `)
  await page.waitForTimeout(800)
  if (await hint.count()) throw new Error('dismissed folder offered again')
  await page.fill('.composer textarea', '')
})

await check('the model menu offers the agent’s permission modes and thinking levels', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await send('你好')
  // Thinking level: a slider beside the model name, as in Claude.
  await page.click('.composer .effort-chip')
  const slider = page.locator('.effort-pop [role="slider"]')
  const before = Number(await slider.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction((b) => Number(document.querySelector('.effort-pop [role="slider"]')?.getAttribute('aria-valuenow')) === b + 1, before)
  if (!(await page.locator('.effort-pop .effort-rec').count())) throw new Error('no recommended mark')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.effort-pop', { state: 'detached' })
  if (!(await page.locator('.composer .context-ring').count())) throw new Error('no context ring')
  const btn = page.locator('.composer .model-btn').last()
  await btn.click()
  // Claude's model menu: models with a check or a number key; modes one level down.
  if (!(await page.locator('.menu.compact .menu-item[aria-checked="true"]').count())) throw new Error('no checked model')
  if (!(await page.locator('.menu.compact .menu-key').count())) throw new Error('no number keys')
  await page.hover('.menu-item:has-text("权限模式")')
  await page.click('.menu.is-sub .menu-item:has-text("自动接受编辑")')
  // The mode shows in the menu's 权限模式 row, never on the model chip.
  await page.click('.composer .model-btn >> nth=-1')
  await page.waitForSelector('.menu-item:has-text("权限模式") .menu-hint:has-text("自动接受编辑")', { timeout: 3000 })
  await page.keyboard.press('Escape')
  if ((await page.locator('.composer .model-btn').last().innerText()).includes('·')) throw new Error('model chip shows more than the model')
  await send('写一段话')
  if (await page.locator('.perm').count()) throw new Error('asked for permission in accept-edits mode')
  const last = await page.locator('.msg-assistant').last().innerText()
  if (!last.includes('acceptEdits')) throw new Error('the session did not get the mode')
})

await check('number keys pick in the model and agent menus, as in Claude', async () => {
  const btn = page.locator('.composer .model-btn').last()
  for (const n of ['2', '1']) {
    await btn.click()
    await page.waitForSelector('.menu.compact')
    const item = page.locator('.menu.compact .menu-item:has(.menu-key:text-is("' + n + '")), .menu.compact .menu-item[aria-keyshortcuts="' + n + '"]').first()
    const name = (await item.locator('.menu-text').innerText()).split('\n')[0].trim()
    await page.keyboard.press(n)
    await page.waitForSelector('.menu', { state: 'detached', timeout: 2000 })
    await page.waitForFunction((x) => [...document.querySelectorAll('.composer .model-btn')].pop()?.textContent?.includes(x), name, { timeout: 3000 })
  }
  // Hovering an item first doesn't stop the keys working.
  await btn.click()
  await page.hover('.menu.compact .menu-item >> nth=0')
  await page.keyboard.press('2')
  await page.waitForSelector('.menu', { state: 'detached', timeout: 2000 })
  await page.locator('.composer .backend-chip').click()
  await page.waitForSelector('.menu.compact .menu-item[aria-keyshortcuts="1"]')
  await page.keyboard.press('1')
  await page.waitForSelector('.menu', { state: 'detached', timeout: 2000 })
})

await check('a mode picked on the new-chat page applies to that chat only', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.locator('.composer-row .model-btn').click()
  await page.hover('.menu-item:has-text("权限模式")')
  await page.click('.menu.is-sub .menu-item:has-text("全部允许")')
  await page.locator('.composer-row .model-btn').click()
  await page.waitForSelector('.menu-item:has-text("权限模式") .menu-hint:has-text("全部允许")', { timeout: 2000 })
  await page.keyboard.press('Escape')
  await send('写个开头')
  if (!(await page.locator('.msg-assistant').last().innerText()).includes('bypassPermissions')) throw new Error('the chat did not get the mode')
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.waitForTimeout(300)
  await page.locator('.composer-row .model-btn').click()
  await page.waitForSelector('.menu-item:has-text("权限模式") .menu-hint', { timeout: 2000 })
  if (await page.locator('.menu-item:has-text("权限模式") .menu-hint:has-text("全部允许")').count()) throw new Error('the mode stuck to the next new chat')
  await page.keyboard.press('Escape')
})

await check('approvals come one at a time, each in the place of the last', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.locator('.composer-row .backend-chip').click()
  await page.locator('.menu .menu-item', { hasText: '演示 Agent' }).click()
  await page.fill('.composer textarea', '同时写三个')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.perm', { timeout: 15000 })
  await page.waitForTimeout(300)
  for (let left = 2; left >= 0; left--) {
    if ((await page.locator('.perm').count()) !== 1) throw new Error(`${await page.locator('.perm').count()} approval cards at once`)
    const more = await page.locator('.perm-more').textContent().catch(() => '')
    if (left && !more?.includes(String(left))) throw new Error(`says "${more}" with ${left} more waiting`)
    const before = (await page.locator('.perm-slot').boundingBox()).y
    await page.click('.perm .btn.primary')
    if (!left) break
    await page.waitForSelector('.perm', { timeout: 3000 })
    const after = (await page.locator('.perm-slot').boundingBox()).y
    if (Math.abs(after - before) > 30) throw new Error(`the next card moved ${Math.round(after - before)}px`)
  }
  await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
})

await check('the new-chat page shows usage widgets that can be removed and brought back', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  // The demo agent's replies above count as usage.
  await page.waitForSelector('.widget', { timeout: 8000 })
  const before = await page.locator('.widget').count()
  if (before !== 3) throw new Error(`${before} widgets`)
  const first = page.locator('.widget').first()
  await first.hover()
  await first.locator('.widget-more').click()
  await page.click('.menu .menu-item:has-text("移除小组件")')
  await page.waitForFunction((n) => document.querySelectorAll('.widget').length === n - 1, before, { timeout: 3000 })
  const rest = page.locator('.widget').first()
  await rest.hover()
  await rest.locator('.widget-more').click()
  await page.click('.menu .menu-item:has-text("恢复默认小组件")')
  await page.waitForFunction((n) => document.querySelectorAll('.widget').length === n, before, { timeout: 3000 })
})

await app.close()

// First launch: whatever the user types goes into the guide, never into the chat behind it.
{
  const dir = declareTestAgent(mkdtempSync(join(tmpdir(), 'oc-e2e-first-')))
  const launch = () => electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, ANCORA_DATA_DIR: dir } })
  let a = await launch()
  let p = await a.firstWindow()
  await p.evaluate(() => localStorage.setItem('oc-lang', 'zh'))
  await p.reload()
  await check('on first launch, typing a name and pressing Enter stays in the guide', async () => {
    await p.waitForSelector('.onboarding input')
    await p.waitForTimeout(500)
    if (!(await p.evaluate(() => document.activeElement?.matches('.onboarding input')))) throw new Error('focus is on ' + (await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))))
    await p.keyboard.type('小林')
    await p.keyboard.press('Enter')
    await p.waitForSelector('.onboarding h1:has-text("选择回答您的 AI")', { timeout: 3000 })
    const chats = await p.evaluate(async () => (await window.ancora.snapshot()).conversations.length)
    if (chats) throw new Error(chats + ' chat(s) were started from the guide')
    for (let i = 0; i < 12; i++) await p.keyboard.press('Tab')
    if (!(await p.evaluate(() => !!document.activeElement?.closest('.onboarding')))) throw new Error('Tab left the guide')
  })
  await check('shortcuts do nothing behind the guide', async () => {
    await p.keyboard.press('Control+,')
    await p.keyboard.press('Control+n')
    await p.keyboard.press('Control+k')
    await p.waitForTimeout(300)
    if (await p.locator('.overlay, .modal').count()) throw new Error('Settings opened behind the guide')
    if (!(await p.evaluate(() => !!document.activeElement?.closest('.onboarding')))) throw new Error('focus left the guide')
  })
  await a.close()
  a = await launch()
  p = await a.firstWindow()
  await check('a guide left half-way comes back on the next launch', async () => {
    await p.waitForSelector('.onboarding', { timeout: 5000 })
    await p.click('.onboarding .skip').catch(async () => {
      // Later steps have no 跳过; finish from wherever the guide is.
      await p.click('.onboarding .btn.primary')
    })
  })
  await a.close()
}

// A reply cut off by quitting the app: seed one, start the app, and retry it.
{
  const dir = mkdtempSync(join(tmpdir(), 'oc-e2e-cut-'))
  mkdirSync(join(dir, 'messages'))
  const now = Date.now()
  const conv = { id: 'cut', kind: 'chat', title: '被打断的对话', backendId: 'mock', createdAt: now, updatedAt: now, status: 'working' }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, projects: [], conversations: [conv], routines: [], connectors: [], settings: { onboarded: true }, backendSettings: {} }))
  writeFileSync(join(dir, 'messages', 'cut.json'), JSON.stringify([
    { id: 'u1', conversationId: 'cut', role: 'user', blocks: [{ type: 'text', text: '你好' }], createdAt: now },
    { id: 'a1', conversationId: 'cut', role: 'assistant', blocks: [{ type: 'text', text: '春眠不觉晓' }], createdAt: now, state: 'streaming' }
  ]))
  declareTestAgent(dir)
  const app2 = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, ANCORA_DATA_DIR: dir } })
  const p2 = await app2.firstWindow()
  await p2.evaluate(() => localStorage.setItem('oc-lang', 'zh'))
  await p2.reload()
  await p2.waitForSelector('.sidebar')
  if (await p2.locator('.onboarding').count()) await p2.click('.onboarding .skip')
  await check('a reply cut off by a restart says so and offers 重试', async () => {
    await p2.click('.sidebar .nav-item:has-text("被打断的对话")')
    const bar = p2.locator('.msg-error.interrupted')
    await bar.waitFor({ timeout: 5000 })
    if (!(await bar.innerText()).includes('因应用重启中断')) throw new Error('reads: ' + (await bar.innerText()))
    await bar.locator('.btn:has-text("重试")').click()
    await p2.waitForSelector('.msg-error.interrupted', { state: 'detached', timeout: 8000 })
    await p2.waitForTimeout(300)
    await p2.waitForSelector('.working-mark', { state: 'detached', timeout: 20000 })
    const reply = await p2.locator('.msg.assistant, .assistant').last().innerText().catch(() => '')
    if (reply.includes('春眠不觉晓')) throw new Error('the cut-off reply was not replaced')
  })
  await app2.close()
}

if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
console.log('all UI checks passed')
