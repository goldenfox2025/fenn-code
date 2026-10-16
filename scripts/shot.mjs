// Drives the built app with Playwright and saves screenshots.
// Usage: xvfb-run -a node scripts/shot.mjs <outDir> [scenario]
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareTestAgent } from './test-agent.mjs'

const out = process.argv[2] ?? 'shots'
const scenario = process.argv[3] ?? 'basic'
const dataDir = process.env.ANCORA_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'oc-'))
declareTestAgent(dataDir)
const app = await electron.launch({
  ...(process.env.APP_PATH ? { executablePath: process.env.APP_PATH, args: ['--no-sandbox'] } : { args: ['.', '--no-sandbox'] }),
  env: { ...process.env, ANCORA_DATA_DIR: dataDir },
  colorScheme: process.env.THEME ?? 'light'
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1600, height: 960 })
await page.waitForSelector('.sidebar')
// Scenarios use Chinese labels; UI_LANG=en shows the English UI instead.
{
  await page.evaluate(async (l) => {
    localStorage.setItem('oc-lang', l)
    await window.ancora.updateSettings({ language: l })
  }, process.env.UI_LANG || 'zh')
  await page.reload()
  await page.waitForSelector('.sidebar')
}
// The first-run guide covers the app; scenarios that aren't about it skip it.
if (!process.env.KEEP_ONBOARDING && (await page.locator('.onboarding').count())) {
  await page.click('.onboarding .skip')
  await page.waitForSelector('.onboarding', { state: 'detached' })
}
// UI_THEME=glass|light|dark sets the app's own theme setting.
if (process.env.UI_THEME) {
  await page.evaluate((x) => window.ancora.updateSettings(x === 'glass' ? { theme: 'dark', glass: true } : x === 'glass-light' ? { theme: 'light', glass: true } : { theme: x, glass: false }), process.env.UI_THEME)
  await page.waitForTimeout(300)
}
const shot = (name) => page.screenshot({ path: join(out, name + '.png') })
const wait = (ms) => page.waitForTimeout(ms)

page.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')))

const scenarios = {
  // The composer footer: model list, effort slider and context ring.
  async footer() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(600)
    const box = await page.locator('.composer-wrap').boundingBox()
    const group = await page.locator('.model-group').boundingBox()
    const right = Math.min(group.x + group.width + 120, 1600)
    const clip = { x: right - 520, y: box.y - 300, width: 520, height: box.height + 300 }
    await page.click('.effort-chip')
    await wait(300)
    await page.screenshot({ path: `${out}/footer-effort.png`, clip })
    await page.keyboard.press('ArrowRight')
    await wait(800)
    await page.screenshot({ path: `${out}/footer-effort-high.png`, clip })
    await page.keyboard.press('Escape')
    await page.click('.model-btn')
    await wait(300)
    await page.screenshot({ path: `${out}/footer-models.png`, clip: { ...clip, y: clip.y - 200, height: clip.height + 200 } })
    await page.keyboard.press('Escape')
    await page.click('.context-ring')
    await wait(300)
    await page.screenshot({ path: `${out}/footer-ring.png`, clip })
    await page.keyboard.press('Escape')
    await page.click('.composer .effort-chip')
    await wait(300)
    await shot('footer-full')
  },
  async versions() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await page.hover('.msg-user')
    await page.click('.msg-user .icon-btn[title="编辑"]')
    await page.fill('.edit-box textarea', '你好呀')
    await page.click('.edit-box .btn.primary')
    await page.waitForSelector('.version-switch', { timeout: 20000 })
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(500)
    await shot('130-versions-2of2')
    await page.click('.version-switch .icon-btn[title="上一个版本"]')
    await wait(800)
    await shot('131-versions-1of2')
  },
  async outputs() {
    const p = await page.evaluate(() => window.ancora.createProject({ name: '竞品调研', backendId: 'mock' }))
    await page.evaluate((id) => window.ancora.startChat({ text: '交付文件 竞品定价.md', backendId: 'mock', projectId: id }), p.id)
    await page.evaluate((id) => window.ancora.startChat({ text: '附上链接 https://example.com/spec', backendId: 'mock', projectId: id }), p.id)
    await wait(2500)
    await page.click('.sidebar :text("交付文件")')
    await wait(800)
    await shot('120-output-card')
    await page.click('.sidebar .nav-item:has-text("项目")')
    await page.click('.page :text("竞品调研")')
    await wait(500)
    await page.click('.panel-head .tab[title="成果"]')
    await wait(400)
    await shot('121-outputs-library')
  },
  async computer() {
    await page.evaluate(() => window.ancora.updateSettings({ computerUse: true }))
    await page.evaluate(() => window.ancora.startChat({ text: '操控电脑，用 记事本', backendId: 'mock' }))
    await page.click('.sidebar :text("操控电脑")')
    if (process.env.MOCK_IMAGES === '0') {
      await page.waitForSelector('.notice', { timeout: 20000 })
      await wait(800)
      await shot('110-computer-unavailable')
      return
    }
    await page.waitForSelector('.perm-app', { timeout: 20000 })
    await page.locator('.perm-app .seg-control button:has-text("仅点击")').click()
    await wait(200)
    await shot('110-computer-ask')
    await page.locator('.perm .btn.primary').click()
    // The whole screen mid-action: the app steps aside and the stop bar shows.
    await wait(1000)
    try {
      execSync(`import -window root ${join(out, '110b-computer-screen.png')}`)
    } catch {}
    await page.waitForSelector('text=我看了屏幕', { timeout: 30000 })
    await wait(800)
    await page.locator('.steps-toggle').last().click().catch(() => {})
    await wait(300)
    await shot('111-computer-done')
  },
  async lists() {
    for (const text of ['你好', '帮我写个周报', '看看这个报错']) await page.evaluate((t) => window.ancora.startChat({ text: t, backendId: 'mock' }), text)
    await wait(3000)
    await page.click('.sidebar .nav-item:has-text("对话")')
    await wait(300)
    await page.locator('.list-row').nth(1).hover()
    await wait(200)
    await shot('100-chats-' + (process.env.UI_THEME || 'light'))
  },
  async install() {
    await page.click('.user-btn')
    await page.click('.settings-nav .nav-item:has-text("Agent 后端")')
    const card = page.locator('.card', { hasText: 'Claude Code' })
    await card.locator('.text-link:has-text("安装")').click()
    // One click only asks: the exact commands, with 取消 focused.
    await page.waitForSelector('.modal.confirm .confirm-code')
    if (!(await page.evaluate(() => document.activeElement?.classList.contains('confirm-cancel')))) throw new Error('取消 should have focus')
    await wait(200)
    await shot('98b-install-confirm')
    await page.click('.modal.confirm .confirm-cancel')
    await wait(300)
    if (await card.locator(':text("正在安装")').count()) throw new Error('取消 must not install')
    await card.locator('.text-link:has-text("安装")').click()
    await page.click('.modal.confirm .btn.primary')
    await page.waitForSelector('.upgrade-help', { timeout: 120000 })
    await card.locator('summary:has-text("详情")').click()
    await wait(400)
    await card.scrollIntoViewIfNeeded()
    await shot('99-install-not-found')
  },
  async usage() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await page.waitForSelector('.usage-btn', { timeout: 5000 })
    await page.hover('.msg-assistant')
    await wait(300)
    await shot('97-usage-message')
    await page.click('.usage-btn')
    await page.waitForSelector('.menu')
    await wait(200)
    await shot('98-usage-menu')
    await page.keyboard.press('Escape')
  },
  async modes() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(500)
    await page.locator('.composer-row .select-btn').last().click()
    await page.waitForSelector('.menu')
    await wait(200)
    await shot('94-modes-menu')
    await page.click('.menu-item:has-text("自动接受编辑")')
    await wait(300)
    await shot('95-mode-chosen')
    await page.click('.user-btn')
    await page.click('.settings-nav .nav-item:has-text("Agent 后端")')
    await page.waitForSelector('.account-line .status-chip', { timeout: 40000 }).catch(() => {})
    await wait(4000)
    await wait(300)
    await shot('96-qoder-account')
    await page.keyboard.press('Escape')
  },
  async folders() {
    await page.fill('.composer textarea', '帮我看看 /tmp 下面的日志')
    await page.waitForSelector('.folder-hint', { timeout: 5000 })
    await shot('92-folder-hint')
    await page.fill('.composer textarea', 'garden planner 的样式')
    await page.click('.folder-chip')
    await page.waitForSelector('.menu')
    await wait(200)
    await shot('93-folder-menu')
    await page.keyboard.press('Escape')
  },
  async progress() {
    const id = await page.evaluate(async () => {
      const api = window.ancora
      const p = await api.createProject({ name: '发布 Ancora', description: '桌面端', backendId: 'mock' })
      const m1 = await api.updateProgress(p.id, { title: '第一版可用', due: '2026-10-20' })
      await api.updateProgress(p.id, { parentId: m1.id, title: '菜单定位修复', status: 'done' })
      await api.updateProgress(p.id, { parentId: m1.id, title: '对话维护', status: 'done' })
      await api.updateProgress(p.id, { parentId: m1.id, title: '项目进度表', status: 'doing', note: '面板和 agent 工具都在做' })
      await api.updateProgress(p.id, { parentId: m1.id, title: '自动寻找文件夹', due: '2026-10-01' })
      const m2 = await api.updateProgress(p.id, { title: 'Qoder 适配' })
      await api.updateProgress(p.id, { parentId: m2.id, title: '登录后实测', status: 'blocked', note: '等用户电脑上登录' })
      const s = await api.updateProgress(p.id, { title: '整理文档', status: 'done' })
      await api.updateProgress(p.id, { id: s.id, suggested: true })
      return p.id
    })
    await page.click(`.sidebar .nav-item:has-text("发布 Ancora")`)
    await page.click('.panel-head .tab[title="进度"]')
    await wait(300)
    await shot('90-progress')
    await page.click('.panel-head .tab:has-text("讨论串")')
    await wait(200)
    await shot('91-progress-summary')
    void id
  },
  async plan() {
    for (const msg of ['#难点 接口返回 403 先排查', '#难点 代理证书过期 换个思路']) {
      await page.fill('.composer textarea', msg)
      await page.keyboard.press('Enter')
      await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
      await wait(500)
    }
    await shot('80-plan-line')
    await page.click('.plan-summary')
    await page.click('.plan-history summary')
    await wait(200)
    await shot('81-plan-open')
  },
  async errors() {
    for (const msg of ['#fail-auth 你好', '#fail-net 再试']) {
      await page.fill('.composer textarea', msg)
      await page.keyboard.press('Enter')
      await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    }
    await page.locator('.msg-error summary').first().click()
    await wait(200)
    await shot('96-errors')
    await page.click('.composer .select-btn')
    await wait(200)
    await shot('96-model-menu')
  },
  async confirm() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    const row = page.locator('.sidebar .nav-item:has(.dot)').first()
    await row.hover()
    await row.locator('.trail .icon-btn').click()
    await page.click('.menu-item:has-text("删除")')
    await page.waitForSelector('.modal.confirm')
    await wait(200)
    await shot('99-confirm')
  },
  async dialogs() {
    await page.click('.composer textarea')
    await page.keyboard.press('Tab')
    await wait(150)
    await shot('97-folder-button-focus')
    await page.click('.nav-item:has-text("项目")')
    await page.click('.page-head .btn')
    await page.waitForSelector('.modal input')
    await page.keyboard.type('家庭装修')
    await wait(150)
    await shot('98-new-project-focus')
  },
  async focus() {
    await page.click('.composer textarea')
    for (let i = 0; i < 2; i++) await page.keyboard.press('Tab')
    await wait(150)
    await shot('95-focus-ring')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await wait(150)
    const ta = await page.evaluate(() => {
      const el = document.activeElement
      const cs = getComputedStyle(el)
      return `${el.tagName} outline=${cs.outlineStyle} shadow=${cs.boxShadow}`
    })
    console.log('composer focus:', ta)
    await shot('96-composer-focus')
  },
  async thinking() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await page.click('.composer .select-btn:has-text("Mock")')
    await page.click('.menu-item:has-text("Mock Smart")')
    await page.fill('.composer textarea', '帮我想想周末去哪玩')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.steps-toggle.live', { timeout: 10000 })
    await shot('90-thinking-live')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(300)
    await shot('91-thinking-folded')
    await page.click('.steps-toggle >> nth=-1')
    await wait(250)
    await shot('92-thinking-open')
  },
  async dropdowns() {
    await page.click('.composer .folder-chip')
    await wait(250)
    await shot('80-folder-chip')
    await page.keyboard.press('Escape')
    await page.click('.composer .select-btn:not(.folder-chip) >> nth=-1')
    await wait(250)
    await shot('81-model-menu')
    await page.keyboard.press('Escape')
    await page.click('.user-btn')
    await wait(300)
    await shot('82-settings')
    await page.click('.modal button:has-text("外观")')
    await wait(200)
    await page.locator('.modal .dropdown').first().click()
    await wait(250)
    await shot('83-settings-dropdown')
  },
  // Run with KEEP_ONBOARDING=1.
  async onboarding() {
    await page.waitForSelector('.onboarding')
    await page.fill('.onboarding input', '小林')
    await shot('70-onboarding-welcome')
    await page.click('.onboarding .modal-actions .btn.primary')
    await wait(200)
    await shot('71-onboarding-backend')
    const grok = page.locator('.choice:has-text("Grok")')
    if (await grok.count()) {
      await grok.click()
      await wait(200)
      await shot('72-onboarding-grok')
    }
    await page.click('.onboarding .modal-actions .btn.primary')
    await page.fill('.onboarding input', '家庭装修')
    await wait(200)
    await shot('73-onboarding-project')
    await page.click('.onboarding .modal-actions .btn.primary')
    await page.waitForSelector('.onboarding', { state: 'detached' })
    await wait(400)
    await shot('74-onboarding-done')
  },
  async about() {
    await page.click('.user-btn')
    await page.click('.settings-nav .nav-item:has-text("关于")')
    await wait(300)
    await shot('75-about')
    await page.click('.settings-body .btn:has-text("检查更新")')
    await wait(300)
    await shot('76-about-checked')
  },
  // Run with MOCK_LAZY=1: the coordinator answers inline and the app offers a thread.
  async lazy() {
    await page.click('.nav-item:has-text("项目")')
    await page.click('.page-head .btn')
    await page.fill('.modal input', '竞品分析')
    await page.click('.modal-actions .btn.primary')
    await page.waitForSelector('.panel')
    await page.fill('.composer textarea', '帮我调研三家竞品的定价')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.thread-suggestion', { timeout: 20000 })
    await wait(300)
    await shot('78-lazy-suggestion')
    await page.click('.thread-suggestion .btn')
    await page.waitForSelector('.thread-row', { timeout: 10000 })
    await wait(2500)
    await shot('79-lazy-thread')
  },
  async chatsEmpty() {
    await page.click('.nav-item:has-text("对话")')
    await wait(200)
    await shot('77-chats-empty')
  },
  async basic() {
    await shot('01-home')
    await page.fill('.composer textarea', '你好！请介绍一下你自己，然后帮我写个笔记')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.perm', { timeout: 15000 })
    await shot('02-permission')
    await page.click('.perm .btn.primary')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(300)
    await shot('03-chat')
  },
  async project() {
    await page.click('.nav-item:has-text("项目")')
    await page.click('.page-head .btn')
    await page.fill('.modal input', 'Ancora')
    await page.fill('.modal input >> nth=1', '跨平台的 Claude 风格桌面应用')
    await page.click('.modal-actions .btn.primary')
    await page.waitForSelector('.panel')
    await wait(300)
    await shot('10-project')
  },
  async routines() {
    await page.click('.nav-item:has-text("定时任务")')
    await page.click('.page-head .btn')
    await page.fill('.modal input >> nth=0', '每日早报')
    await page.fill('.modal textarea', '整理昨天各讨论串的进展，列出今天要我决定的事')
    await wait(200)
    await shot('20-routine-dialog')
    await page.click('.modal-actions .btn.primary')
    await wait(400)
    await shot('21-routines')
  },
  async settings() {
    await page.click('.sidebar-foot .icon-btn')
    await wait(200)
    await page.click('.settings-nav .nav-item:has-text("Agent 后端")')
    await wait(200)
    await shot('30-settings-backends')
    await page.click('.settings-nav .nav-item:has-text("外观")')
    await page.click('.btn:has-text("深色")')
    await page.click('.settings-close')
    await wait(300)
    await shot('31-dark')
  },
  async compose() {
    const f = join(dataDir, 'notes.md')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(f, '# 会议纪要\n- 讨论了发布计划\n')
    await page.setInputFiles('.composer-wrap input[type=file]', f)
    await page.fill('.composer textarea', '总结一下这个文件')
    await wait(200)
    await shot('05-attach-chip')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(300)
    await shot('06-attach-sent')
    const users = page.locator('.msg-user')
    await users.last().hover()
    await users.last().locator('.icon-btn[title="编辑"]').click()
    await page.fill('.edit-box textarea', '用一句话总结这个文件')
    await shot('07-editing')
    await page.click('.edit-box .btn.primary')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(300)
    await shot('08-edited')
  },
  async files() {
    await page.click('.panel-head .tab[title="项目文件"]')
    // A non-ASCII name, as users' files often have.
    await page.setInputFiles('.panel input[type=file]', {
      name: '产品规格.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 产品规格\n登录要支持扫码。\n')
    })
    await wait(800)
    await page.fill('.center .composer textarea', '看看项目文件')
    await page.keyboard.press('Enter')
    await wait(2500)
    await shot('16-project-files')
  },
  async connectors() {
    await page.click('.sidebar-foot .icon-btn')
    await page.click('.settings-nav .nav-item:has-text("连接器")')
    await page.click('.btn:has-text("添加连接器")')
    await page.fill('.settings-body input >> nth=0', 'filesystem')
    await page.fill('.settings-body input >> nth=1', 'npx -y @modelcontextprotocol/server-filesystem ~/Documents')
    await wait(200)
    await shot('32-connector-form')
    await page.click('.settings-body .btn.primary:has-text("保存")')
    await wait(400)
    await shot('33-connectors')
    await page.click('.settings-close')
  },
  async decision() {
    await page.click('.nav-item:has-text("新建")')
    await page.fill('.composer textarea', '帮我决定发布日期')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.decision', { timeout: 15000 })
    await wait(800)
    await shot('60-decision')
    await page.click('.decision-opt >> nth=0')
    await page.waitForSelector('.decision-opt.chosen')
    await wait(1500)
    await shot('61-decision-chosen')
  },
  async page() {
    await page.click('.nav-item:has-text("新建")')
    await page.fill('.composer textarea', '做个页面')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.page-frame', { timeout: 15000 })
    await wait(1500)
    const frame = page.frameLocator('.page-frame')
    await frame.locator('#b').click()
    await frame.locator('#b').click()
    await wait(300)
    console.log('counter after two clicks:', await frame.locator('#n').textContent())
    await shot('70-page')
  },
  async autoassign() {
    await page.click('.nav-item:has-text("新建")')
    await page.fill('.composer textarea', '给 Ancora 桌面应用想个发布口号')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.msg-system', { timeout: 20000 })
    await wait(500)
    await shot('40-autoassign')
  },
  async threads() {
    await page.fill('.center .composer textarea', '帮我调研一下 ACP 协议的会话管理')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.thread-card')
    await wait(900)
    await shot('11-thread-started')
    await page.click('.thread-card')
    await page.waitForSelector('.thread-view')
    await wait(600)
    await shot('12-thread-working')
    await page.waitForSelector('.thread-view .status-chip.waiting', { timeout: 20000 })
    await wait(300)
    await shot('13-thread-done')
    await page.fill('.center .composer textarea', '帮我写一份发布说明')
    await page.keyboard.press('Enter')
    await wait(1200)
    await page.click('.pill-btn:has-text("概览")')
    await wait(400)
    await shot('14-overview')
    await page.click('.panel .icon-btn >> nth=-1')
    await wait(3500)
    await page.fill('.center .composer textarea', '现在进展如何？')
    await page.keyboard.press('Enter')
    await wait(1500)
    await shot('15-status-answer')
  }
}
try {
  for (const s of scenario.split(',')) await scenarios[s]()
} catch (e) {
  await shot('error')
  console.log(String(e).slice(0, 300))
}
await app.close()
console.log('screenshots in', out, 'data', dataDir)
