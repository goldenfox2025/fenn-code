// Isolated, hidden UI checks for reply controls and reported usage. No model calls.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-footer-ui-')))
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
const chat = randomUUID(), empty = randomUUID(), first = randomUUID(), second = randomUUID(), characters = randomUUID(), continuous = randomUUID()
const now = Date.now()
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light' }
state.conversations = [
  { id: chat, kind: 'chat', backendId: 'mock', title: '回复页脚 · 测试数据', status: 'idle', createdAt: now, updatedAt: now },
  { id: empty, kind: 'chat', backendId: 'mock', title: '无正文回复 · 测试数据', status: 'idle', createdAt: now, updatedAt: now },
  { id: continuous, kind: 'chat', backendId: 'mock', title: '连续推进 · 测试数据', status: 'idle', createdAt: now, updatedAt: now }
]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
mkdirSync(join(data, 'messages'))
writeFileSync(join(data, 'messages', `${chat}.json`), JSON.stringify([
  { id: first, conversationId: chat, role: 'assistant', state: 'done', createdAt: now,
    blocks: [{ type: 'text', text: '这一条包含较大的缓存读取记录。正文保持清楚，用量明细由底部入口打开。' }],
    usage: { input: 4000, cachedRead: 186000, output: 1571 },
    timing: { firstResponseMs: 500, streamMs: 4000, outputTokens: 1571, tpotMs: 4000 / 1571 } },
  { id: randomUUID(), conversationId: chat, role: 'user', createdAt: now, blocks: [{ type: 'text', text: '开始另一轮任务。' }] },
  { id: second, conversationId: chat, role: 'assistant', state: 'done', createdAt: now + 1,
    blocks: [{ type: 'text', text: '下一条回复不应与上一条的操作栏重叠。没有上报用量时，不显示用量入口。' }] },
  { id: randomUUID(), conversationId: chat, role: 'user', createdAt: now + 1, blocks: [{ type: 'text', text: '查看没有 token 报告的情况。' }] },
  { id: characters, conversationId: chat, role: 'assistant', state: 'done', createdAt: now + 2,
    blocks: [{ type: 'text', text: '只知道文字接收速度时，使用字/秒，不虚构 token 速度。' }],
    usage: { total: 0 }, timing: { firstResponseMs: 200, streamMs: 5000, outputChars: 200, noSpeed: 'output' } }
]))
writeFileSync(join(data, 'messages', `${empty}.json`), JSON.stringify([
  { id: randomUUID(), conversationId: empty, role: 'assistant', state: 'error', createdAt: now,
    blocks: [], error: 'Test fixture: unavailable backend' }
]))
const tools = (n) => Array.from({ length: n }, (_, i) => ({ type: 'tool', toolId: randomUUID(), title: `Read source-${i}.ts`, toolKind: 'read', status: 'completed', input: '{}', output: 'Fixture result' }))
writeFileSync(join(data, 'messages', `${continuous}.json`), JSON.stringify([
  { id: randomUUID(), conversationId: continuous, role: 'assistant', state: 'done', createdAt: now,
    blocks: [{ type: 'text', text: '先核对入口，再继续检查调用关系。' }, ...tools(2), { type: 'text', text: '入口已核对，接着检查执行路径。' }, ...tools(8)] },
  { id: randomUUID(), conversationId: continuous, role: 'assistant', state: 'done', createdAt: now + 1,
    blocks: [{ type: 'text', text: '这一轮检查结束，给出结论。' }] },
  { id: randomUUID(), conversationId: continuous, role: 'assistant', state: 'done', createdAt: now + 2,
    blocks: [{ type: 'tool', toolId: randomUUID(), title: 'fenn/submit_review', toolKind: 'other', status: 'completed' }] }
]))
const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const shots = join(data, 'shots')
mkdirSync(shots)
try {
  await page.waitForSelector('.sidebar')
  // The initial saved-language migration may reload the renderer once.
  await page.waitForLoadState('networkidle')
  await resizeViewport(page, { width: 1440, height: 960 })
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())))
  await page.locator('.sidebar .nav-item').filter({ hasText: '回复页脚 · 测试数据' }).click()
  const reply = page.locator(`[data-mid="${first}"]`)
  const next = page.locator(`[data-mid="${second}"]`)
  const footer = reply.locator('.assistant-actions')
  await footer.waitFor()
  assert.match(await footer.innerText(), /输入 190k.*输出 1,571/)
  assert.equal(await next.locator('.reply-metrics').count(), 0, 'Missing metrics stay absent')
  const previous = await next.boundingBox()
  await footer.hover()
  assert.equal((await next.boundingBox()).y, previous.y, 'Metadata never moves a later reply on hover')
  assert.equal(await footer.getByRole('button', {name:'本条回复用量',exact:true}).count(), 0, 'No submenu for reply metrics')
  assert.match(await footer.innerText(), /TPOT/)
  assert(!/费用|没有速度/.test(await footer.innerText()))
  assert.match(await page.locator(`[data-mid="${characters}"] .reply-metrics`).innerText(), /40.0 字\/秒/)
  await reply.getByRole('button', {name:'回复操作',exact:true}).count().then(async count=>{if(count){await reply.getByRole('button',{name:'回复操作',exact:true}).click();assert.equal(await page.getByRole('menuitem',{name:'添加回应',exact:true}).count(),0);await page.keyboard.press('Escape')}})
  console.log('PASS: inline reported metrics, TPOT, omitted missing values and no reaction menu')
  for (const [theme, width, height] of [['light', 1440, 960], ['dark', 620, 900]]) {
    await page.evaluate((theme) => window.fenn.updateSettings({ theme }), theme)
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme)
    await resizeViewport(page, { width, height })
    await reply.scrollIntoViewIfNeeded()
    const footerBox = await footer.boundingBox(), nextBox = await next.boundingBox()
    assert(footerBox.y + footerBox.height <= nextBox.y, 'A footer must not overlap the next reply')
    assert(await footer.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'Compact footer must fit narrow windows')
    await page.screenshot({ path: join(shots, `footer-${theme}-${width}.png`) })
  }
  await page.locator('.sidebar .nav-item').filter({ hasText: '无正文回复 · 测试数据' }).click()
  const blank = page.locator('.assistant-actions')
  await blank.waitFor({ state: 'attached' })
  assert(!await blank.isVisible(), 'An entirely empty footer must take no space')
  await page.locator('.sidebar .nav-item').filter({ hasText: '连续推进 · 测试数据' }).click()
  await page.locator('.steps-toggle').filter({ hasText: '调用了 8 次工具' }).waitFor()
  assert.equal(await page.locator('.assistant-actions').count(), 1, 'Intermediate progress must not have completion footers')
  assert.equal(await page.locator('.tool-row').count(), 0, 'Adjacent tool calls should start folded')
  assert.equal(await page.locator('.steps-toggle').filter({ hasText: '调用了 2 次工具' }).count(), 1, 'Short adjacent runs should also fold')
  await page.locator('.steps-toggle').filter({ hasText: '调用了 2 次工具' }).click()
  assert.equal(await page.locator('.tool-row').count(), 2, 'Disclosure must preserve individual tool details')
  await page.locator('.steps-toggle').filter({ hasText: '调用了 2 次工具' }).click()
  await page.screenshot({ path: join(shots, 'continuous-progress.png') })
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())))
  console.log('PASS: light/dark and narrow layouts, no overlap, empty footer omitted; windows stayed hidden')
  console.log('PASS: continuous progress has one settled footer; adjacent tools fold without crossing prose')
  console.log('FOOTER_UI_PROFILE', data)
} catch (error) {
  await page.screenshot({ path: join(data, 'failure.png') }).catch(() => {})
  console.error('FOOTER_UI_FAILED', data)
  throw error
} finally { await app.close() }
