// Drives the built app with Playwright and saves screenshots.
// Usage: xvfb-run -a node scripts/shot.mjs <outDir> [scenario]
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareTestAgent } from './test-agent.mjs'

const out = process.argv[2] ?? 'shots'
const scenario = process.argv[3] ?? 'basic'
const dataDir = process.env.ANCORA_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'oc-'))
// MANY_BACKENDS=12 declares that many extra agents (copies of the demo one), to see long lists.
if (process.env.MANY_BACKENDS) {
  const names = ['Gemini CLI', 'Qwen Code', 'Kimi CLI', 'OpenCode', 'Goose', 'Cline', 'Augment', 'Cursor Agent', 'Aider', 'Amp', 'Crush', 'Junie', 'Warp', 'Devin', 'Roo']
  const agent = fileURLToPath(new URL('../resources/mock-agent.mjs', import.meta.url))
  writeFileSync(join(dataDir, 'backends.json'), JSON.stringify(names.slice(0, Number(process.env.MANY_BACKENDS)).map((name, i) => ({ id: 'extra' + i, name, command: process.execPath, args: [agent] }))))
}
declareTestAgent(dataDir)
// A year of earlier replies, so the home page's usage heatmap has something to show.
if (scenario.includes('heatmap')) {
  const now = Date.now()
  const day = 86400000
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const messages = []
  const MODELS = [{ backendId: 'mock', id: 'mock-smart', name: 'Mock Smart' }, { backendId: 'mock', id: 'mock-fast', name: 'Mock Fast' }, { backendId: 'codex', id: 'gpt', name: 'GPT' }, { backendId: 'grok', id: 'grok', name: 'Grok' }, { backendId: 'claude', id: 'sonnet', name: 'Sonnet' }, { backendId: 'qoder', id: 'auto', name: 'Auto' }]
  for (let d = 330; d >= 0; d--) {
    const weekend = new Date(now - d * day).getDay() % 6 === 0
    if (rand() < (weekend ? 0.7 : 0.25)) continue
    const n = 1 + Math.floor(rand() * (d < 60 ? 12 : 5))
    for (let i = 0; i < n; i++)
      messages.push({ id: `seed-${d}-${i}`, conversationId: 'seed', role: 'assistant', state: 'done', createdAt: now - d * day + i * 60000, blocks: [{ type: 'text', text: '…' }], usage: { input: Math.floor(rand() * 40000), output: Math.floor(rand() * 6000) }, model: MODELS[Math.floor(rand() * rand() * MODELS.length)] })
  }
  mkdirSync(join(dataDir, 'messages'), { recursive: true })
  writeFileSync(join(dataDir, 'messages', 'seed.json'), JSON.stringify(messages))
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ version: 1, projects: [], routines: [], conversations: [{ id: 'seed', kind: 'chat', title: '去年的对话', backendId: 'mock', status: 'idle', createdAt: now - 330 * day, updatedAt: now - 330 * day }], settings: { onboarded: true }, backendSettings: {} }))
}
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
/** Opens one of the project panel's views under 「…」 (成果, 项目资料, 项目记忆, 定时任务, 里程碑). */
const panelView = async (label) => {
  await page.click('.panel-head [data-more]')
  await page.click(`.menu .menu-item:has-text("${label}")`)
}
const shot = (name) => page.screenshot({ path: join(out, name + '.png') })
const wait = (ms) => page.waitForTimeout(ms)

page.on('console', (m) => m.type() === 'error' && console.log('[renderer]', m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')))

const scenarios = {
  // The project menu with its notification levels, and @ in the project chat.
  async projectmenu() {
    await page.click('.nav-item:has-text("项目")')
    await page.click('.page-head .btn')
    await page.fill('.modal input', '躺平研究')
    await page.click('.modal-actions .btn.primary')
    await page.waitForSelector('.panel')
    await page.fill('.composer textarea', '帮我调研躺平一辈子要多少钱')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.thread-card', { timeout: 15000 })
    await wait(2500)
    await page.click('.sidebar .nav-item:has-text("躺平研究")', { button: 'right' })
    await page.hover('.menu .menu-item:has-text("通知")')
    await page.waitForSelector('.menu.is-sub')
    await wait(400)
    await shot('project-menu')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.click('.center .workspace > .center .composer textarea')
    await page.keyboard.type('@躺平')
    await page.waitForSelector('.mention-menu')
    await wait(300)
    await shot('mention-menu')
    await page.keyboard.press('Enter')
    await page.keyboard.type('再算一下在大理的情况')
    await wait(300)
    await shot('mention-chip')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.thread-event.kind-forwarded')
    await wait(500)
    await shot('mention-sent')
    // A narrow window: the thread panel opens over the conversation.
    await page.setViewportSize({ width: 900, height: 760 })
    await wait(300)
    await page.click('[data-tip="打开讨论串"]')
    await page.waitForSelector('.panel.floating')
    await wait(400)
    if (process.env.DEBUG_FLOAT) console.log(await page.$eval('.panel.floating', (el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.opacity, c.zIndex, c.position, c.backdropFilter, c.filter].join(' | ') }))
    await shot('floating')
  },
  // The plan card at the top of a thread: running, then done and folded.
  async plancard() {
    await page.click('.nav-item:has-text("项目")')
    await page.click('.page-head .btn')
    await page.fill('.modal input', '躺平研究')
    await page.click('.modal-actions .btn.primary')
    await page.waitForSelector('.panel')
    await page.fill('.composer textarea', '帮我调研躺平一辈子要多少钱')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.thread-card', { timeout: 15000 })
    await page.click('.thread-card')
    await page.waitForSelector('.panel .plan-step.doing', { timeout: 15000 })
    await wait(1200)
    await shot('plan-working')
    await page.waitForSelector('.panel .status-chip:has-text("等待您")', { timeout: 30000 })
    await wait(400)
    await shot('plan-done')
    await page.click('.panel .plan-summary')
    await wait(300)
    await shot('plan-opened')
    // Full screen, as Claude opens a thread.
    await page.click('.panel .panel-head .icon-btn[data-tip="全屏"]')
    await wait(400)
    await shot('thread-fullscreen')
  },
  // MOCK_AUTH=1: the agent is installed but signed out; the picker says so instead of failing.
  async signedout() {
    await wait(2500)
    await page.click('.model-btn')
    await wait(500)
    await shot('signed-out-picker')
  },
  // The sidebar with chats in a few folders, one without a folder, and a pinned project.
  async sidebar() {
    const base = mkdtempSync(join(tmpdir(), 'work-'))
    const dirs = ['web-shop', 'text-adventure'].map((n) => join(base, n))
    for (const d of dirs) mkdirSync(d, { recursive: true })
    const p = await page.evaluate(() => window.ancora.createProject({ name: 'Ancora', backendId: 'mock' }))
    await page.evaluate((id) => window.ancora.updateProject(id, { pinned: true }), p.id)
    const chats = [
      ['网站首页改版', dirs[0]],
      ['把图片压缩脚本的 CPU 降下来', dirs[0]],
      ['文字冒险游戏重构', dirs[1]],
      ['周末去哪儿玩', undefined],
      ['帮我起草一封邮件', undefined]
    ]
    for (const [text, cwd] of chats) {
      await page.evaluate(([text, cwd]) => window.ancora.startChat({ text, backendId: 'mock', cwd }), [text, cwd])
      await wait(400)
    }
    await wait(2500)
    await page.hover('.sidebar .section-head >> nth=-1')
    await wait(300)
    await page.screenshot({ path: `${out}/sidebar.png`, clip: { x: 0, y: 0, width: 300, height: 960 } })
    await page.click('.sidebar .nav-item:has-text("对话")')
    await wait(800)
    await shot('chats-page')
  },
  // A sub-conversation the agent handed side work to, nested under its parent.
  async subchat() {
    const dir = join(mkdtempSync(join(tmpdir(), 'work-')), 'web-shop')
    mkdirSync(dir, { recursive: true })
    await page.evaluate((cwd) => window.ancora.startChat({ text: '网站首页改版', backendId: 'mock', cwd }), dir)
    await wait(1500)
    const parent = await page.evaluate((cwd) => window.ancora.startChat({ text: '开子对话 降低图片压缩脚本的CPU占用', backendId: 'mock', cwd }), dir)
    await wait(3000)
    await page.click(`.sidebar .nav-item:has-text("开子对话")`)
    await wait(800)
    await shot('subchat-parent')
    await page.click('.thread-card')
    await wait(1000)
    await page.click('.handoff-ctx')
    await wait(300)
    await shot('subchat-child')
  },
  // A Codex-style turn: its opening line stays above the steps; inside, reasoning reads as markdown and searches by what they looked up.
  async news() {
    await page.evaluate(() => window.ancora.startChat({ text: '#搜新闻 最近有什么新闻', backendId: 'mock' }))
    await page.click('.sidebar .nav-item >> text=/搜新闻/')
    await page.waitForSelector('.turn.streaming', { state: 'detached', timeout: 20000 })
    await wait(400)
    await shot('news-steps')
    await page.click('.turn .steps-toggle')
    await page.locator('.turn .steps-toggle').nth(1).click()
    await wait(300)
    await shot('news-steps-open')
  },
  // One turn: steps line, answer, a card and the action row; then the working mark mid-turn.
  async turn() {
    const c = await page.evaluate(() => window.ancora.startChat({ text: '#啰嗦 开子对话 看板上能看到这个讨论串吗？', backendId: 'mock' }))
    await page.click('.sidebar .nav-item >> text=/啰嗦/')
    await page.waitForSelector('.thread-card', { timeout: 20000 })
    await page.waitForSelector('.turn.streaming', { state: 'detached', timeout: 20000 })
    await wait(600)
    await page.hover('.turn .md')
    await wait(300)
    await shot('turn-done')
    await page.click('.turn .steps-toggle')
    await wait(300)
    await shot('turn-steps-open')
    await page.click('.turn .steps-toggle')
    await page.fill('.composer textarea', '#啰嗦慢 再确认一次')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.working-mark')
    await wait(2600)
    await shot('turn-working')
    await page.waitForSelector('.turn.streaming', { state: 'detached', timeout: 20000 })
    await page.click('.composer .effort-chip')
    await page.hover('.effort-help')
    await page.waitForSelector('.tooltip.on')
    await wait(300)
    await shot('tooltip')
    void c
  },
  // Many agents: the backend menu keeps four and puts the rest under 更多后端.
  async many() {
    await wait(1500)
    const box = await page.locator('.composer-wrap').boundingBox()
    const clip = { x: box.x - 20, y: box.y - 420, width: box.width + 300, height: 960 - (box.y - 420) }
    await page.click('.backend-chip')
    await wait(300)
    await page.screenshot({ path: `${out}/many-backends.png`, clip })
    await page.hover('.menu .menu-item:has-text("更多后端")')
    await wait(500)
    await page.screenshot({ path: `${out}/many-backends-more.png`, clip })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.click('.model-btn')
    await wait(300)
    await page.screenshot({ path: `${out}/many-models.png`, clip })
    await page.keyboard.press('Escape')
  },
  // The composer footer: model list, effort slider and context ring.
  async footer() {
    await page.fill('.composer textarea', '你好')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(600)
    const box = await page.locator('.composer-wrap').boundingBox()
    const clip = { x: box.x + box.width - 640, y: box.y - 300, width: 660, height: box.height + 310 }
    await page.click('.effort-chip')
    await wait(300)
    await page.screenshot({ path: `${out}/footer-effort.png`, clip })
    await page.keyboard.press('ArrowRight')
    await wait(800)
    await page.screenshot({ path: `${out}/footer-effort-high.png`, clip })
    await page.keyboard.press('End')
    await wait(800)
    await page.screenshot({ path: `${out}/footer-effort-max.png`, clip })
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
    await page.click('.msg-user .icon-btn[data-tip="编辑"]')
    await page.fill('.edit-box textarea', '你好呀')
    await page.click('.edit-box .btn.primary')
    await page.waitForSelector('.version-switch', { timeout: 20000 })
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(500)
    await shot('130-versions-2of2')
    await page.click('.version-switch .icon-btn[data-tip="上一个版本"]')
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
    await panelView('成果')
    await wait(400)
    await shot('121-outputs-library')
  },
  async computer() {
    await page.evaluate(() => window.ancora.updateSettings({ computerUse: true }))
    await page.evaluate(() => window.ancora.startChat({ text: '操控电脑，用 记事本', backendId: 'mock' }))
    await page.click('.sidebar :text("操控电脑")')
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
    for (const text of ['你好', '#大上下文 再说一点', '谢谢']) {
      await page.fill('.composer textarea', text)
      await page.keyboard.press('Enter')
      await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
      await wait(300)
    }
    await page.hover('.msg-assistant')
    await wait(300)
    await shot('97-usage-message')
    await page.click('.composer .context-ring')
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
    await panelView('里程碑')
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
  // A message sent while the reply runs waits in view; 停止 puts it back in the composer.
  async queued() {
    await page.evaluate(() => window.ancora.startChat({ text: '#啰嗦慢', backendId: 'mock' }))
    await page.click('.sidebar :text("#啰嗦慢")')
    await page.waitForSelector('.send-btn.stop', { timeout: 15000 })
    await page.fill('.composer textarea', '顺便把结论整理成表格')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.queue-row', { timeout: 5000 })
    await wait(400)
    await shot('130-queued')
    await page.click('.send-btn.stop')
    await page.waitForFunction(() => document.querySelector('.composer textarea')?.value.includes('整理成表格'), null, { timeout: 5000 })
    await wait(300)
    await shot('131-queued-returned')
  },
  // The reaction row under a reply, a reaction pill, and a / command in a sent message.
  async reactions() {
    await page.evaluate(() => window.ancora.startChat({ text: '你好', backendId: 'mock' }))
    await page.click('.sidebar :text("你好")')
    await page.waitForSelector('.msg-assistant .msg-actions', { timeout: 15000 })
    await page.hover('.msg-assistant')
    await page.click('.msg-assistant .msg-actions .icon-btn >> nth=1')
    await page.waitForSelector('.menu.row')
    await wait(300)
    await shot('140-reaction-menu')
    await page.click('.menu.row .menu-item >> nth=2')
    await page.fill('.composer textarea', '/always-approve on')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.cmd-token', { timeout: 5000 })
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 15000 })
    await page.hover('.msg-user >> nth=-1')
    await wait(300)
    await shot('141-reaction-command')
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
  // The files and background pane beside a chat, and the / menu.
  async heatmap() {
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.click('.sidebar .nav-item:has-text("新建")')
    await page.waitForSelector('.heatmap')
    await wait(400)
    await shot('heatmap')
    await page.hover('.heatmap-week:nth-last-child(3) .heat-cell.l3, .heatmap-week:nth-last-child(3) .heat-cell.l4, .heatmap-week:nth-last-child(3) .heat-cell.l2 >> nth=0')
    await wait(500)
    await shot('heatmap-tip')
  },
  async bubbles() {
    await page.setViewportSize({ width: 1200, height: 800 })
    const c = await page.evaluate(() => window.ancora.startChat({ text: '你好', backendId: 'mock' }))
    await wait(1500)
    await page.click(`.sidebar .nav-item:has-text("你好")`)
    await page.evaluate((id) => window.ancora.send(id, '/always-approve'), c.id)
    await wait(1200)
    await page.evaluate((id) => window.ancora.send(id, '生成一个测试文件'), c.id)
    await wait(1500)
    const users = page.locator('.msg.msg-user')
    await users.nth((await users.count()) - 1).hover()
    await wait(300)
    await shot('bubbles-hover')
  },
  async sidepane() {
    await page.setViewportSize({ width: 1600, height: 900 })
    const dir = join(mkdtempSync(join(tmpdir(), 'work-')), 'text-adventure')
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'README.md'), '# Text adventure\n\nA small engine for branching stories.\n\n- Scenes are plain Markdown\n- Choices link scenes\n')
    writeFileSync(join(dir, 'src', 'engine.ts'), 'export function next(scene: string, choice: number): string {\n  return `${scene}.${choice}`\n}\n')
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "text-adventure"\n')
    const c = await page.evaluate((cwd) => window.ancora.startChat({ text: '写文件 计划.md', backendId: 'mock', cwd }), dir)
    await wait(1500)
    await page.click(`.sidebar .nav-item:has-text("写文件")`)
    await page.waitForSelector('.side-pane-toggle')
    await page.evaluate((id) => window.ancora.send(id, '后台运行 echo 正在启动开发服务器; echo 监听 http://localhost:5173; sleep 60'), c.id)
    await wait(1200)
    await page.click('.side-pane-toggle')
    await page.waitForSelector('.side-pane')
    await wait(300)
    await shot('side-background')
    await page.click('.bg-command .row1')
    await wait(1500)
    await shot('side-background-output')
    await page.click('.side-pane .tab:has-text("文件")')
    await page.waitForSelector('.tree-row')
    await page.click('.tree-row:has-text("README.md")')
    await wait(400)
    await shot('side-files')
    if (await page.locator('.preview-head .icon-btn[aria-label="返回文件列表"]').count()) await page.click('.preview-head .icon-btn[aria-label="返回文件列表"]')
    await page.click('.tree-row:has-text("src")')
    await page.click('.files-tools .chip')
    await wait(300)
    await shot('side-changes')
    await page.click('.side-pane .icon-btn[aria-label="关闭"]')
    await page.fill('.composer textarea', '/')
    await wait(200)
    await shot('slash-menu')
    await page.keyboard.press('Enter')
    await page.keyboard.type('排查 ECONNRESET')
    await wait(200)
    await shot('slash-chip')
    await page.keyboard.press('Enter')
    await wait(1200)
    await shot('slash-sent')
  },
  // The project panel at an ordinary laptop width: tabs, the library and routines.
  async panel() {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.click('.nav-item:has-text("项目")')
    await page.click('.page-head .btn')
    await page.fill('.modal input', '测试项目')
    await page.click('.modal-actions .btn.primary')
    await page.waitForSelector('.panel')
    await wait(400)
    await shot('panel-threads')
    await page.click('.panel-head .tab[data-tab="library"]')
    await wait(300)
    await shot('panel-library')
    await page.click('.panel-head [data-more]')
    await shot('panel-more')
    await page.click('.menu .menu-item:has-text("定时任务")')
    await wait(300)
    await shot('panel-routines')
    await page.fill('.composer textarea', '/')
    await wait(200)
    await shot('panel-slash')
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
    const users = page.locator('.msg.msg-user')
    await users.last().hover()
    await users.last().locator('.icon-btn[data-tip="编辑"]').click()
    await page.fill('.edit-box textarea', '用一句话总结这个文件')
    await shot('07-editing')
    await page.click('.edit-box .btn.primary')
    await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
    await wait(300)
    await shot('08-edited')
  },
  async files() {
    await panelView('项目资料')
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
    await page.fill('.composer textarea', '写文件 计划.md')
    await page.keyboard.press('Enter')
    // The folder the app makes once the agent writes a file gets its own header in the sidebar.
    await page.waitForSelector('.sidebar .folder-head:has-text("写文件")', { timeout: 30000 })
    await page.hover('.sidebar .folder-head >> nth=0')
    await wait(500)
    await shot('40-autoassign')
    // With a folder chosen, its menu is about that folder only.
    await page.click('.composer .folder-chip')
    await page.waitForSelector('.menu')
    await wait(300)
    await shot('41-folder-menu')
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
