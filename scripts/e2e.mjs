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
await page.evaluate(() => localStorage.setItem('oc-lang', 'zh'))
await page.reload()
await page.waitForSelector('.sidebar')
// The first-run guide covers the app; scenarios that aren't about it skip it.
if (!process.env.KEEP_ONBOARDING && (await page.locator('.onboarding').count())) {
  await page.click('.onboarding .skip')
  await page.waitForSelector('.onboarding', { state: 'detached' })
}
let failed = 0
async function check(name, fn) {
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
  await page.waitForSelector('.working-timer', { state: 'detached', timeout: 20000 })
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
  await page.click('.glass-toggle')
  await page.waitForFunction(() => /^glass/.test(document.documentElement.dataset.theme))
  await page.waitForTimeout(200)
  const glass = await scrollTest()
  console.log(`   slowest scroll frame: ${Math.round(plain)} ms ${before}, ${Math.round(glass)} ms glass (software rendering)`)
  await page.click('.glass-toggle')
  await page.waitForFunction((b) => document.documentElement.dataset.theme === b, before)
})

await check('Esc closes dialogs, and Settings keeps one size on every tab', async () => {
  await page.click('.user-btn')
  await page.waitForSelector('.modal.wide')
  const sizes = new Set()
  for (const tab of ['通用', '外观', 'Agent 后端', '连接器', '关于']) {
    await page.click(`.settings-nav .nav-item:has-text("${tab}")`)
    await page.waitForTimeout(120)
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
  const rows = page.locator('.sidebar .nav-item:has(.dot)')
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
  await page.waitForFunction((n) => document.querySelectorAll('.sidebar .nav-item .dot').length < n, before, { timeout: 3000 })
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
  const row = page.locator('.sidebar .nav-item:has(.dot)').first()
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
  await page.click('.tab[title="项目记忆"]')
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

await check('the sidebar has no Agent 后端 entry; the composer picker ends with 管理 Agent 后端…', async () => {
  if (await page.locator('.sidebar .nav-item:has-text("Agent 后端")').count()) throw new Error('sidebar still has Agent 后端')
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.locator('.composer-row .select-btn').last().click()
  await page.waitForSelector('.menu')
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
  const label = (await page.locator('.composer .select-btn').last().innerText()).trim()
  if (!/^Mock (Fast|Smart)/.test(label)) throw new Error('home shows: ' + label)
})

await check('the new-chat page keeps the greeting and composer in place', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  const top = async () => Math.round((await page.locator('.home .composer').boundingBox()).y)
  const greet = async () => Math.round((await page.locator('.home .greeting').boundingBox()).y)
  const [c0, g0] = [await top(), await greet()]
  await page.locator('.composer-row .select-btn').last().click()
  await page.locator('.menu .menu-item', { hasText: '演示 Agent' }).click()
  await page.fill('.composer textarea', '一\n二\n三\n四\n五\n六')
  await page.waitForTimeout(200)
  if ((await top()) !== c0 || (await greet()) !== g0) throw new Error(`moved: composer ${c0}→${await top()}, greeting ${g0}→${await greet()}`)
  await page.fill('.composer textarea', '')
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
    const b = await btn.boundingBox()
    await page.waitForSelector('.menu', { timeout: 2000 })
    await page.waitForTimeout(80)
    const m = await page.locator('.menu').boundingBox()
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
    const row = rows.nth(i)
    await row.hover()
    const btn = row.locator('.trail .icon-btn')
    await btn.click()
    await near(btn, 'sidebar row ' + (await row.innerText()).trim())
  }
  const header = page.locator('.chat-header .icon-btn:has(.lucide-ellipsis), .chat-header .icon-btn:has(.lucide-more-horizontal)').last()
  await header.click()
  await near(header, 'chat header')
  await page.waitForSelector('.working-timer', { state: 'detached', timeout: 20000 })
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

await check('the chats page selects several chats to move or delete at once', async () => {
  await page.click('.sidebar .nav-item:has-text("对话")')
  const before = await page.locator('.page .list-row').count()
  if (before < 3) throw new Error('need at least 3 chats, have ' + before)
  await page.click('.page-head .btn:has-text("选择")')
  await page.locator('.page .list-row').nth(0).click()
  await page.locator('.page .list-row').nth(1).click()
  if (!(await page.locator('.select-bar').innerText()).includes('已选 2 个')) throw new Error('selection count wrong')
  await page.click('.select-bar .btn:has-text("移到项目")')
  await page.click('.menu-item:has-text("端到端")')
  await page.waitForTimeout(300)
  const moved = await page.evaluate(async () => (await window.ancora.snapshot()).conversations.filter((c) => c.kind === 'chat' && c.projectId).length)
  if (moved < 2) throw new Error('moved ' + moved)
  await page.click('.page-head .btn:has-text("选择")')
  await page.locator('.page .list-row').nth(0).click()
  await page.click('.select-bar .btn:has-text("删除")')
  await page.click('.modal.confirm .btn.danger-solid')
  await page.waitForFunction((n) => document.querySelectorAll('.page .list-row').length === n - 1, before, { timeout: 3000 })
})

await check('a project keeps a progress board of milestones and tasks, edited by hand', async () => {
  await page.click('.sidebar .recent-projects .nav-item:has-text("端到端")')
  // Threads are the milestones: the board only appears once something is on it (here, a goal the agent recorded).
  if (await page.locator('.panel-head .tab[title="进度"]').count()) throw new Error('empty progress board shown')
  await page.evaluate(async () => {
    const p = (await window.ancora.snapshot()).projects.find((x) => x.name.includes('端到端'))
    await window.ancora.updateProgress(p.id, { title: '第一版上线' })
  })
  await page.click('.panel-head .tab[title="进度"]')
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
  for (const h of ['Agent 后端', '模型', '权限模式']) if (!(await page.locator(`.menu .menu-label:has-text("${h}")`).count())) throw new Error('no ' + h)
  await page.click('.menu-item:has-text("自动接受编辑")')
  await page.waitForSelector('.select-btn .mode-note:has-text("自动接受编辑")', { timeout: 3000 })
  await send('写一段话')
  if (await page.locator('.perm').count()) throw new Error('asked for permission in accept-edits mode')
  const last = await page.locator('.msg-assistant').last().innerText()
  if (!last.includes('acceptEdits')) throw new Error('the session did not get the mode')
})

await check('a mode picked on the new-chat page applies to that chat only', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.locator('.composer-row .select-btn').last().click()
  await page.click('.menu-item:has-text("全部允许")')
  await page.waitForSelector('.composer-row .mode-note:has-text("全部允许")', { timeout: 2000 })
  await send('写个开头')
  if (!(await page.locator('.msg-assistant').last().innerText()).includes('bypassPermissions')) throw new Error('the chat did not get the mode')
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.waitForTimeout(300)
  if (await page.locator('.composer-row .mode-note:has-text("全部允许")').count()) throw new Error('the mode stuck to the next new chat')
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
    await p2.waitForSelector('.working-timer', { state: 'detached', timeout: 20000 })
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
