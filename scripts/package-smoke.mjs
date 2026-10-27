// Exercise the shipped app outside the checkout so local node_modules cannot
// hide missing production dependencies. No account, model request or install.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const release = resolve('release')
const candidates = process.platform === 'darwin'
  ? ['mac-universal/Fenn Code.app', `mac-${process.arch}/Fenn Code.app`, 'mac/Fenn Code.app']
  : process.platform === 'win32' ? ['win-unpacked'] : ['linux-unpacked']
const source = candidates.map((p) => join(release, p)).find(existsSync)
assert(source, 'Build an unpacked app with npm run dist first')
const temp = mkdtempSync(join(tmpdir(), 'fenn-code-package-smoke-'))
const staged = join(temp, process.platform === 'darwin' ? 'Fenn Code.app' : 'app')
const shots = join(release, 'package-smoke')
mkdirSync(shots, { recursive: true })
cpSync(source, staged, { recursive: true, verbatimSymlinks: true })
const executablePath = process.platform === 'darwin'
  ? join(staged, 'Contents/MacOS/Fenn Code')
  : join(staged, process.platform === 'win32' ? 'FennCode.exe' : 'fenn-code')
const packagedResources = process.platform === 'darwin' ? join(staged, 'Contents/Resources') : join(staged, 'resources')
assert(!existsSync(join(packagedResources, 'mock-agent.mjs')), 'Release must not ship the demo agent script')
// Fixtures live outside the installed application, declared only in isolated test data.
const agentFixture = join(temp, 'fixture-agent.mjs')
cpSync(resolve('resources/mock-agent.mjs'), agentFixture)
const data = join(temp, 'data')
const catalogGate = join(temp, 'catalog-ready')
mkdirSync(data)
writeFileSync(join(data, 'state.json'), JSON.stringify({ version: 1,
  projects: [], conversations: [], routines: [], backendSettings: {},
  settings: { defaultBackendId: 'mock', onboarded: true, language: 'zh', theme: 'glass' } }))
writeFileSync(join(data, 'backends.json'), JSON.stringify([{
  id: 'mock', name: '演示 Agent', command: process.execPath, args: [agentFixture]
}, {
  id: 'plain-metrics', name: 'Metrics test agent', command: process.execPath, args: [agentFixture],
  env: { MOCK_SIMPLE_STREAM: '1', MOCK_USAGE: 'no-cost' }
}, {
  id: 'cold-catalog', name: 'Cold catalog', command: process.execPath, args: [agentFixture],
  env: { MOCK_CATALOG_GATE: catalogGate }
}, {
  id: 'missing-smoke', name: 'Unavailable smoke agent', command: join(temp, 'does-not-exist')
}, {
  id: 'package-smoke', name: 'Package smoke agent', command: process.execPath,
  upgrade: {
    // Never executed: the test opens this confirmation and cancels it.
    run: { command: 'fenn-code-test-do-not-run', args: ['install', '-g', '@qoder-ai/qodercli@latest', 'a-long-command-argument-'.repeat(12)] },
    latest: { command: process.execPath, args: ['--version'] }
  }
}]))
const env = { ...process.env, FENN_DEMO_AGENT: '1', FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1', NODE_PATH: '', MOCK_DYNAMIC_EFFORT: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
let app
let page
async function waitState(predicate, arg) {
  const deadline = Date.now() + 30000
  do {
    if (await page.evaluate(predicate, arg)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for app state')
}
try {
  // Even the former development switch must not enable a built-in demo in a release.
  app = await electron.launch({ executablePath, cwd: temp,
    args: [`--user-data-dir=${join(temp, 'production-profile')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...env, FENN_DATA_DIR: join(temp, 'production-data') }, timeout: 45_000 })
  page = await app.firstWindow({ timeout: 30_000 })
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), 'Packaged acceptance must not present test windows')
  const production = await page.evaluate(() => window.fenn.snapshot())
  assert(!production.backends.some((b) => b.id === 'mock'), 'Release must not offer a demo backend')
  assert(!('glass' in production.settings), 'Retired glass switch is absent')
  assert.notEqual(production.settings.defaultBackendId, 'mock')
  await app.close()
  app = undefined
  console.log('Production build has no demo backend or bundled demo script')
  app = await electron.launch({ executablePath, cwd: temp,
    args: [`--user-data-dir=${join(temp, 'profile')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env,
    timeout: 45_000 })
  page = await app.firstWindow({ timeout: 30_000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
  assert(info.packaged, 'Must test the shipped app, not the development entry point')
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), 'Fixture acceptance must remain hidden')
  const appearance = await page.evaluate(async () => (await window.fenn.snapshot()).settings)
  assert.equal(appearance.theme, 'dark', 'Legacy glass theme migrates to opaque dark')
  assert(!('glass' in appearance), 'Retired glass switch is removed')
  console.log('Packaged startup passed:', info)
  console.log('Native window and display:', await app.evaluate(({ BrowserWindow, screen }) => ({
    bounds: BrowserWindow.getAllWindows()[0].getBounds(), workArea: screen.getPrimaryDisplay().workArea
  })))

  // As in Claude's composer: one list for the agent, its models and modes, and an effort slider beside it.
  if (process.env.PACKAGE_ONLY !== 'charts') {
  const picker = () => page.locator('.composer .model-btn')
  const openPicker = () => picker().click()
  // Agents are in the chip left of the model; anything past the first few is one level down.
  const AGENTS = /Qoder|演示 Agent|Cold catalog|Codex|Claude Code|Grok/
  const choose = async (name) => {
    await (AGENTS.test(String(name)) ? page.locator('.composer .backend-chip') : picker()).click()
    const item = page.getByRole('menuitemradio', { name })
    if (!(await item.count())) await page.getByRole('menuitem', { name: /^更多(后端|模型)/ }).hover()
    await item.first().click()
    await page.locator('.menu').first().waitFor({ state: 'detached' })
  }
  const effortStops = async () => {
    await page.locator('.composer .effort-chip').click()
    const titles = await page.locator('.effort-pop .effort-stop').evaluateAll((els) => els.map((e) => e.getAttribute('data-tip')))
    return titles
  }
  const chooseEffort = async (name) => {
    const titles = await effortStops()
    const i = titles.findIndex((x) => name.test(x))
    assert(i >= 0, `no effort stop ${name}: ${titles}`)
    await page.locator('.effort-pop .effort-stop').nth(i).click({ force: true })
    await page.keyboard.press('Escape')
    await page.locator('.effort-pop').waitFor({ state: 'detached' })
  }
  const effortIs = async (name) => name.test(await page.locator('.composer .effort-chip').innerText())
  const NONE = /^不启用推理/
  const LOW = /^低/

  // Pick a model before sending any message; no chat or generated usage exists.
  await choose(/^Mock Smart/)
  assert.equal(await page.evaluate(async () => (await window.fenn.snapshot()).conversations.length), 0)
  await picker().filter({ hasText: 'Mock Smart' }).waitFor()
  await waitState(async () => (await window.fenn.snapshot()).settings.backendModelDefaults?.mock === 'mock-smart')
  await chooseEffort(NONE)
  await waitState(async () => (await window.fenn.snapshot()).settings.backendOptionDefaults?.mock?.effort === 'none')
  console.log('Model selection before the first message passed')

  // The picker keeps a gap from its button and fits the viewport, including
  // when a narrow composer moves its controls onto a second row.
  await page.setViewportSize({ width: 1200, height: 800 })
  await openPicker()
  for (const [width, height] of [[1200, 800], [860, 560]]) {
    await page.setViewportSize({ width, height })
    await page.waitForFunction(() => {
      const menu = document.querySelector('.menu')?.getBoundingClientRect()
      const button = document.querySelector('.composer .model-btn')?.getBoundingClientRect()
      return menu && button && (menu.top >= button.bottom + 5 || menu.bottom <= button.top - 5) && menu.top >= 7 && menu.bottom <= innerHeight - 7 && menu.left >= 7 && menu.right <= innerWidth - 7
    })
    await page.screenshot({ path: join(shots, `model-menu-${width}.png`) })
  }
  await page.keyboard.press('Escape')
  console.log('Model menu gap, viewport fit and live resize passed')

  const configFile = join(data, 'backends.json')
  const declared = JSON.parse(readFileSync(configFile, 'utf8'))
  declared.push({ id: 'hot-reloaded', name: 'Hot-reloaded agent', command: process.execPath })
  writeFileSync(configFile, JSON.stringify(declared))
  await waitState(async () => (await window.fenn.snapshot()).backends.some((b) => b.id === 'hot-reloaded'))
  console.log('External backend configuration hot reload passed')

  await page.locator('.sidebar-foot button[data-tip="设置"]').click()
  await page.locator('.settings-nav').getByText('Agent 后端', { exact: true }).click()
  const card = page.locator('.settings-body .card').filter({ hasText: 'Package smoke agent' })
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await card.getByRole('button', { name: '升级', exact: true }).waitFor()
  for (const [theme, width, height] of [['light', 1200, 800], ['light', 860, 560], ['dark', 860, 560]]) {
    await page.evaluate((x) => window.fenn.updateSettings({ theme: x }), theme)
    await page.setViewportSize({ width, height })
    await card.getByRole('button', { name: '升级', exact: true }).click()
    const modal = page.locator('.modal.confirm')
    await modal.waitFor()
    const layout = await modal.evaluate((el) => {
      const box = (q) => { const r = el.querySelector(q).getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
      const r = el.getBoundingClientRect()
      return { title: box('h2'), text: box('.confirm-text'), code: box('.confirm-code'), actions: box('.modal-actions'),
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
        width: innerWidth, height: innerHeight, cancelFocused: document.activeElement === el.querySelector('.confirm-cancel') }
    })
    assert(layout.title.bottom <= layout.text.top + 1, JSON.stringify(layout))
    assert(layout.text.bottom <= layout.code.top + 1, JSON.stringify(layout))
    assert(layout.code.bottom <= layout.actions.top + 1, JSON.stringify(layout))
    assert(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height, JSON.stringify(layout))
    assert(layout.scrollWidth <= layout.clientWidth, JSON.stringify(layout))
    assert(layout.cancelFocused, 'Cancel must be initially focused')
    await page.screenshot({ path: join(shots, `upgrade-${theme}-${width}.png`) })
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.modal.wide').count(), 1, 'Cancel only closes the confirmation, preserving Settings')
  }
  console.log('Upgrade dialog layout, themes, long commands and Escape passed')
  await page.keyboard.press('Escape')

  // The Chats page, reached from the sidebar, can delete one row directly.
  const chats = await page.evaluate(async () => {
    const result = []
    for (const title of ['打包测试待删除', '打包测试保留']) {
      const chat = await window.fenn.startChat({ backendId: 'mock', text: '你好' })
      await window.fenn.updateConversation(chat.id, { title })
      result.push(chat.id)
    }
    return result
  })
  await waitState(async (ids) => (await window.fenn.snapshot()).conversations.filter((c) => ids.includes(c.id)).every((c) => c.status === 'idle'), chats)
  await page.locator('.sidebar').getByRole('button', { name: '对话', exact: true }).click()
  await page.evaluate(() => window.fenn.updateSettings({ theme: 'light' }))
  const remove = page.getByRole('button', { name: '删除对话「打包测试待删除」', exact: true })
  await remove.click()
  await page.locator('.confirm-cancel').click()
  assert.equal(await remove.count(), 1)
  await page.screenshot({ path: join(shots, 'chats-delete-entry.png') })
  await remove.click()
  await page.locator('.modal.confirm .danger-solid').click()
  await remove.waitFor({ state: 'detached' })
  assert(await page.evaluate(async (id) => (await window.fenn.snapshot()).conversations.some((c) => c.id === id), chats[1]))
  console.log('Chats-page single deletion and cancellation passed')

  // Configure the built-in Qoder card through the UI. This JS fixture uses the
  // external test agent, never a real Qoder account or model service.
  const qoderDir = join(temp, 'qoder path with spaces')
  mkdirSync(qoderDir)
  const qoderEntry = join(qoderDir, 'qoder entry.mjs')
  writeFileSync(qoderEntry, `
    if (process.argv[2] === 'status') {
      console.log(JSON.stringify({ logged_in: true, version: 'packaged-fixture' }))
    } else if (process.argv[2] === '--acp') {
      await import(${JSON.stringify(pathToFileURL(agentFixture).href)})
    } else if (process.argv[2] === '--print') {
      if (process.env.QODER_AGENT_SDK_ENTRYPOINT !== 'fenn-code-usage') process.exit(8)
      const { createInterface } = await import('node:readline')
      createInterface({ input: process.stdin }).on('line', (line) => {
        const request = JSON.parse(line)
        if (request.type !== 'control_request') process.exit(9)
        const response = request.request.subtype === 'get_usage_info'
          ? { usage: { userQuota: { used: 12.5, total: 100, remaining: 87.5, unit: 'credits' } }, session: { total_credits: 999 } } : {}
        console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } }))
      })
    } else process.exit(2)
  `)
  await page.locator('.sidebar-foot button[data-tip="设置"]').click()
  await page.locator('.settings-nav').getByText('Agent 后端', { exact: true }).click()
  const qoderCard = page.locator('.settings-body .card').filter({ has: page.locator('.title').getByText('Qoder', { exact: true }) })
  // A real local installation may already be signed in: reveal its path fields
  // through the same advanced-settings disclosure the user uses.
  const initialAdvanced = qoderCard.locator('details').filter({ has: page.locator('summary').getByText('高级设置', { exact: true }) })
  if (await initialAdvanced.count() && await initialAdvanced.getAttribute('open') == null) await initialAdvanced.locator('summary').click()
  for (const [label, value] of [['Node 路径（用于 Qoder JS 入口）', process.execPath], ['Qoder CLI 路径', qoderEntry]]) {
    const field = qoderCard.locator('.field').filter({ has: page.locator('label').getByText(label, { exact: true }) })
    // The field has no 保存 button: Enter (or leaving it) saves, as in the app's other settings.
    await field.locator('input').fill(value)
    await field.scrollIntoViewIfNeeded()
    const editing = await field.boundingBox()
    await field.locator('input').press('Enter')
    await field.getByRole('button', { name: '修改', exact: true }).waitFor()
    // The account line refreshes after a save; it must not nudge the field either.
    await page.waitForTimeout(800)
    assert.deepEqual(await field.boundingBox(), editing, `Saving ${label} must preserve field geometry`)
  }
  const advanced = qoderCard.locator('details.backend-advanced')
  await advanced.waitFor()
  assert.equal(await advanced.evaluate((d) => d.open), true, 'Saving paths preserves the user-opened settings and their layout')
  await advanced.locator('summary').click()
  assert.equal(await advanced.evaluate((d) => d.open), false, 'The user can collapse the settings explicitly')
  await advanced.locator('summary').click()
  assert.equal(await advanced.locator('.field').filter({ hasText: '已设置' }).count(), 2, 'Both saved paths show as set under 高级设置')
  assert.deepEqual(await page.evaluate(() => window.fenn.backendAccount('qoder')), {
    installed: true, signedIn: true, version: 'packaged-fixture', detail: 'qodercli packaged-fixture'
  })
  await page.screenshot({ path: join(shots, 'qoder-path-settings.png') })
  await page.keyboard.press('Escape')
  const qoderChat = await page.evaluate(async () => (await window.fenn.startChat({ backendId: 'qoder', text: 'hello configured Qoder' })).id)
  await waitState(async (id) => {
    const messages = await window.fenn.messages(id)
    return (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.status === 'idle' && messages.some((m) => m.role === 'assistant' && m.state === 'done')
  }, qoderChat)
  assert.equal(await page.evaluate(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id).backendId, qoderChat), 'qoder')
  console.log('Qoder path settings, account check and packaged ACP reply passed')

  await page.evaluate((id) => window.fenn.updateConversation(id, { title: 'Qoder Credits smoke' }), qoderChat)
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Qoder Credits smoke' }).click()
  await page.locator('.composer .account-quota-ring').waitFor()
  assert.equal(await page.locator('.reply-metrics').count(), 0, 'Qoder does not present token counts as billing')
  const geometry = () => page.evaluate(() => ({
    window: [scrollX, scrollY],
    content: [...document.querySelectorAll('.chat-header, .center .transcript-shell > .scroll, .center > .composer')].map((el) => {
      const r = el.getBoundingClientRect()
      return [r.x, r.y, r.width, r.height, el.scrollTop]
    })
  }))
  for (const theme of ['light', 'dark']) {
    await page.evaluate((x) => window.fenn.updateSettings({ theme: x }), theme)
    for (const selector of ['.composer .account-quota-ring', '.chat-header button[aria-label="更多对话操作"]']) {
      await page.locator('.center .transcript-shell > .scroll').evaluate((el) => {
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 24)
        el.dispatchEvent(new Event('scroll'))
      })
      const before = await geometry()
      await page.locator(selector).click()
      const surface = '.menu'
      await page.locator(surface).waitFor()
      assert.deepEqual(await geometry(), before, 'Opening the menu must not move the transcript or composer')
      await page.keyboard.press('End')
      await page.keyboard.press('Home')
      assert.deepEqual(await geometry(), before, 'Menu navigation must only scroll the menu')
      if (selector.includes('account-quota-ring')) {
        assert.match(await page.locator(surface).innerText(), /12\.5\s*\/ 100 credits/)
        assert.equal(await page.getByRole('meter', { name: '套餐', exact: true }).getAttribute('aria-valuenow'), '12.5')
        assert.match(await page.locator(surface).innerText(), /13%/)
        assert(!/999|tokens/.test(await page.locator(surface).innerText()))
        await page.screenshot({ path: join(shots, `qoder-credits-${theme}.png`), animations: 'disabled' })
      }
      await page.keyboard.press('Escape')
    }
  }
  console.log('Qoder account Credits and stable usage/more popovers passed in three themes')

  await page.locator('.sidebar .nav-item').filter({ hasText: '打包测试保留' }).click()
  // Account quota and reported context use the same quiet composer slot.
  assert.equal(await page.locator('.chat-header .usage-btn').count(), 0)
  await page.locator('.composer .context-ring').click()
  // The ring's panel keeps the context and the cost as reported (its per-kind rows went in the leaner panel);
  // the reply's own line keeps its input and output.
  assert.match(await page.locator('.menu').innerText(), /上下文\n[\d,.k]+ \/ [\d,.k]+/)
  assert.match(await page.locator('.menu').innerText(), /费用\n后端报告\n\$[\d.]+/)
  assert.match(await page.locator('.reply-metrics').last().innerText(), /输入 [\d,.k]+ · 输出 [\d,.k]+/)
  assert(!/未提供/.test(await page.locator('.menu').innerText()))
  await page.keyboard.press('Escape')
  console.log('Other agents retain reported tokens and costs, without an invented account quota')

  const shortChat = await page.evaluate(async () => (await window.fenn.startChat({ backendId: 'plain-metrics', text: 'stream timing' })).id)
  await waitState(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.status === 'idle', shortChat)
  await page.evaluate((id) => window.fenn.updateConversation(id, { title: 'Short reply smoke' }), shortChat)
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Short reply smoke' }).click()
  assert.equal(await page.locator('.reply-metrics').count(), 0, 'Short replies do not add a usage footer')

  const metricsChat = await page.evaluate(async () => (await window.fenn.startChat({ backendId: 'plain-metrics', text: '#long-timing' })).id)
  await waitState(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.status === 'idle', metricsChat)
  await page.evaluate((id) => window.fenn.updateConversation(id, { title: 'Observed timing smoke' }), metricsChat)
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Observed timing smoke' }).click()
  for (const theme of ['light', 'dark']) {
    await page.evaluate((x) => window.fenn.updateSettings({ theme: x }), theme)
    const trigger = page.locator('.composer .context-ring')
    const before = await geometry()
    await trigger.click()
    const panel = page.locator('.menu')
    await panel.waitFor()
    assert(!/费用|未提供/.test(await panel.innerText()))
    assert.match(await panel.innerText(), /最近一次回复[\s\S]*[\d.]+ tok\/s[\s\S]*(毫秒|秒) \/ token/)
    assert.match(await page.locator('.reply-metrics').innerText(), /tok\/s.*TPOT/)
    assert.equal(await panel.getByRole('meter', { name: '上下文', exact: true }).getAttribute('aria-valuemax'), '200000')
    const layout = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el)
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: innerHeight, width: innerWidth,
        outline: css.outlineStyle, overflow: el.scrollWidth > el.clientWidth }
    })
    assert(layout.outline === 'none' && !layout.overflow, JSON.stringify(layout))
    assert(layout.top >= 0 && layout.bottom <= layout.height && layout.left >= 0 && layout.right <= layout.width, JSON.stringify(layout))
    assert.deepEqual(await geometry(), before)
    await page.screenshot({ path: join(shots, `usage-panel-${theme}.png`), animations: 'disabled' })
    await panel.screenshot({ path: join(shots, `usage-panel-${theme}-detail.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    assert(await trigger.evaluate((el) => document.activeElement === el))
  }
  console.log('Usage menu, hidden missing costs, context meter, observed timing and keyboard focus passed')

  // Each agent remembers its own model and thinking level.
  await page.locator('.sidebar').getByRole('button', { name: '新建', exact: true }).click()
  await picker().filter({ hasText: 'Mock Smart' }).waitFor()
  assert(await effortIs(NONE))
  await choose(/^Qoder/)
  await choose(/^Mock Smart/)
  await waitState(async () => (await window.fenn.snapshot()).settings.backendModelDefaults?.qoder === 'mock-smart')
  assert(!(await effortStops()).some((x) => NONE.test(x)), 'Qoder does not expose none')
  await page.keyboard.press('Escape')
  await chooseEffort(LOW)
  await waitState(async () => (await window.fenn.snapshot()).settings.backendOptionDefaults?.qoder?.effort === 'low')
  await choose(/^演示 Agent/)
  await page.waitForFunction(() => /^不启用推理/.test(document.querySelector('.composer .effort-chip')?.textContent ?? ''))
  await choose(/^Qoder/)
  await page.waitForFunction(() => /^低/.test(document.querySelector('.composer .effort-chip')?.textContent ?? ''))
  console.log('Per-agent model and reasoning restoration passed')

  // An idle chat can change agent; the new agent's models load without sending anything.
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Qoder Credits smoke' }).click()
  const beforeCold = await page.evaluate((id) => window.fenn.messages(id), qoderChat)
  await choose(/^Cold catalog/)
  await openPicker()
  await page.locator('.menu').getByText('正在加载模型…', { exact: true }).waitFor()
  assert.equal(await page.locator('.menu').getByText(/发送第一条消息/).count(), 0)
  writeFileSync(catalogGate, 'ready')
  await page.getByRole('menuitemradio', { name: /^Mock Smart/ }).waitFor()
  await page.waitForFunction(() => {
    const r = document.querySelector('.menu')?.getBoundingClientRect()
    return r && r.top >= 7 && r.bottom <= innerHeight - 7
  })
  await page.getByRole('menuitemradio', { name: /^Mock Smart/ }).click()
  await waitState(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.modelId === 'mock-smart', qoderChat)
  await chooseEffort(LOW)
  await waitState(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.optionValues?.effort === 'low', qoderChat)
  assert.deepEqual(await page.evaluate((id) => window.fenn.messages(id), qoderChat), beforeCold)
  for (const theme of ['light', 'dark']) {
    await page.evaluate((x) => window.fenn.updateSettings({ theme: x }), theme)
    assert(await effortIs(LOW))
    await page.locator('.composer .effort-chip').click()
    await page.screenshot({ path: join(shots, `effort-${theme}.png`) })
    await page.keyboard.press('Escape')
    await openPicker()
    await page.keyboard.press('ArrowDown')
    assert.match(await page.locator('.menu-item.active').getAttribute('role'), /^menuitem/)
    await page.screenshot({ path: join(shots, `model-picker-${theme}.png`) })
    await page.keyboard.press('Escape')
  }
  console.log('Agent switch, model discovery before a message and keyboard navigation preserve the history')

  // Project and routine choices use the same availability policy as the composer.
  await page.locator('.sidebar').getByRole('button', { name: '项目', exact: true }).first().click()
  for (const [theme, width, height] of [['light', 1200, 800], ['dark', 860, 560]]) {
    await page.evaluate((x) => window.fenn.updateSettings({ theme: x }), theme)
    await page.setViewportSize({ width, height })
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    const modal = page.locator('.modal').filter({ has: page.getByRole('heading', { name: '新建项目', exact: true }) })
    const field = (label) => modal.locator('.field').filter({ has: page.locator('label').getByText(label, { exact: true }) })
    const instructions = field('项目指令').locator('textarea')
    // Measured once the dialog has finished rising in (its entrance scales it from 98%); an animation
    // cancelled meanwhile (its element went) counts as over.
    await page.evaluate(() => Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)))
    const initial = await instructions.boundingBox()
    await instructions.fill('项目指令 Project instructions\n保持一致的位置和间距。')
    const filled = await instructions.boundingBox()
    assert.deepEqual(filled, initial, 'Typing must not resize or move the instructions field')
    const metrics = await modal.evaluate((el) => {
      const area = el.querySelector('textarea')
      const css = getComputedStyle(area)
      const row = el.querySelector('.field-row')
      const folder = row.querySelector('input').getBoundingClientRect()
      const browse = row.querySelector('button').getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: innerWidth, height: innerHeight,
        overflow: el.scrollWidth > el.clientWidth, paddingTop: parseFloat(css.paddingTop), paddingBottom: parseFloat(css.paddingBottom),
        lineHeight: parseFloat(css.lineHeight), folderTop: folder.top, browseTop: browse.top, folderHeight: folder.height, browseHeight: browse.height }
    })
    assert(metrics.paddingTop >= 8 && metrics.paddingBottom >= 8 && metrics.lineHeight >= 20, JSON.stringify(metrics))
    assert.equal(metrics.folderTop, metrics.browseTop)
    assert.equal(metrics.folderHeight, metrics.browseHeight)
    assert(!metrics.overflow && metrics.left >= 0 && metrics.right <= metrics.width && metrics.top >= 0 && metrics.bottom <= metrics.height, JSON.stringify(metrics))
    await field('后端').locator('.dropdown').click()
    assert.equal(await page.getByRole('menuitemradio', { name: /Unavailable smoke agent/ }).count(), 0)
    await page.getByRole('menuitemradio', { name: /^Qoder(?:\s|$)/ }).waitFor()
    await page.screenshot({ path: join(shots, `project-form-${theme}.png`) })
    await page.keyboard.press('Escape')
    await modal.getByRole('button', { name: '取消', exact: true }).click()
  }
  await page.locator('.sidebar').getByRole('button', { name: '定时任务', exact: true }).click()
  await page.getByRole('button', { name: '新建定时任务', exact: true }).click()
  const routine = page.locator('.modal').filter({ has: page.getByRole('heading', { name: '新建定时任务', exact: true }) })
  await routine.locator('.field').filter({ has: page.locator('label').getByText('后端', { exact: true }) }).locator('.dropdown').click()
  assert.equal(await page.getByRole('menuitemradio', { name: /Unavailable smoke agent/ }).count(), 0)
  await page.getByRole('menuitemradio', { name: /^Qoder(?:\s|$)/ }).waitFor()
  await page.keyboard.press('Escape')
  await routine.getByRole('button', { name: '取消', exact: true }).click()
  console.log('Available-only project/routine pickers and stable form alignment passed across themes and window sizes')

  if (process.platform === 'darwin') {
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    for (let round = 0; round < 2; round++) {
      for (const value of [true, false]) {
        await app.evaluate(async ({ BrowserWindow }, value) => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win.isFullScreen() === value) return
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Fullscreen transition timed out')), 15_000)
            win.once(value ? 'enter-full-screen' : 'leave-full-screen', () => { clearTimeout(timer); resolve() })
            win.setFullScreen(value)
          })
        }, value)
      }
    }
    // Cocoa may emit leave-full-screen before the last restored-frame update.
    const restored = await app.evaluate(async ({ BrowserWindow }, expected) => {
      const win = BrowserWindow.getAllWindows()[0]
      const matches = () => Math.abs(win.getBounds().width - expected.width) <= 1 && Math.abs(win.getBounds().height - expected.height) <= 1
      const deadline = Date.now() + 5000
      while (!matches() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
      return { fullscreen: win.isFullScreen(), resizable: win.isResizable(), bounds: win.getBounds(), normalBounds: win.getNormalBounds() }
    }, bounds)
    console.log('macOS fullscreen restoration:', { before: bounds, after: restored })
    assert(!restored.fullscreen && restored.resizable)
    assert(Math.abs(bounds.width - restored.bounds.width) <= 1 && Math.abs(bounds.height - restored.bounds.height) <= 1, JSON.stringify({ before: bounds, after: restored }))
    console.log('macOS native fullscreen enter/exit and restored size passed twice')
  }
  }
  // Rendering from the staged app catches missing runtime libraries that a
  // checkout's node_modules would otherwise hide. No account or model API.
  await page.evaluate(() => window.fenn.startChat({ text: '#折线图', backendId: 'mock' }))
  await page.locator('.sidebar .nav-item').filter({ hasText: '#折线图' }).last().click()
  const chart = page.locator('.interactive-preview').last().frameLocator('iframe').locator('canvas')
  await chart.waitFor({ timeout: 20000 })
  const plotted = await chart.evaluate((el) => {
    const c = Chart.getChart(el)
    return { type: c?.config.type, values: c?.data.datasets[0].data }
  })
  assert.equal(plotted.type, 'line')
  assert.deepEqual(plotted.values, [12, 20, null, 18, 32, 26])
  await page.screenshot({ path: join(shots, 'offline-chart.png') })
  console.log('Packaged offline chart rendered from outside the checkout')
  assert.deepEqual(errors, [], 'Renderer errors')
  console.log('All packaged-app smoke checks passed')
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
    console.error(await page.locator('body').innerText().catch(() => 'No renderer body'))
  }
  throw error
} finally {
  if (app) await app.close()
  // Only remove the isolated directory created by this script.
  assert.equal(dirname(resolve(temp)), resolve(tmpdir()))
  assert(dirname(resolve(temp)) === resolve(tmpdir()) && basename(temp).startsWith('fenn-code-package-smoke-'), 'Cleanup stays inside this smoke test temporary directory')
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
