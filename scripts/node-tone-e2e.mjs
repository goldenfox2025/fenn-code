// Hidden local fixtures for the shared Code/Bot node ridge; no provider prompts.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const shots = resolve('.local/node-tone-ui')
mkdirSync(shots, { recursive: true })
// The separate Bot checkout is optional; Code's checks run independently.
const botRoot = process.env.FENN_BOT_ROOT ? resolve(process.env.FENN_BOT_ROOT) : null
if (botRoot && !existsSync(join(botRoot, 'package.json'))) throw Error('FENN_BOT_ROOT must point to a built Bot checkout')
for (const kind of botRoot ? ['code', 'bot'] : ['code']) {
  const data = mkdtempSync(join(tmpdir(), 'fenn-node-tone-' + kind + '-'))
  const bot = kind === 'bot', cwd = bot ? botRoot : process.cwd()
  const now = Date.now()
  const messages = Array.from({ length: 14 }, (_, i) => [
    { id: 'u' + i, role: 'user', text: '问题 ' + (i + 1) + '：峰顶最深，附近的刻度逐级变灰。' },
    { id: 'a' + i, role: 'assistant', text: '回复 ' + (i + 1) + '：保留连续的山形轮廓，只有峰顶采用最深颜色。' }
  ]).flat()
  if (bot) {
    writeFileSync(join(data, 'backends.json'), JSON.stringify([{ id: 'fixture', name: 'Local fixture', command: process.execPath, args: [resolve('resources/mock-agent.mjs')] }]))
    writeFileSync(join(data, 'state.json'), JSON.stringify({ bots: [{ id: 'main', name: 'Fenn', backendId: 'fixture', instructions: '', status: 'idle', messages: messages.map((m, i) => ({ id: m.id, role: m.role, at: now + i, blocks: [{ kind: 'text', text: m.text }] })) }], config: { theme: 'light', browserMode: 'isolated', computerEnabled: false }, backendSettings: {} }))
  } else {
    declareTestAgent(data)
    const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
    state.settings = { ...state.settings, theme: 'light', language: 'zh', onboarded: true, dotGrid: 0 }
    state.conversations = [{ id: 'chat', title: '节点明暗检查', kind: 'chat', backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now }]
    writeFileSync(join(data, 'state.json'), JSON.stringify(state))
    mkdirSync(join(data, 'messages'))
    writeFileSync(join(data, 'messages', 'chat.json'), JSON.stringify(messages.map((m, i) => ({ id: m.id, conversationId: 'chat', role: m.role, state: 'done', createdAt: now + i, blocks: [{ type: 'text', text: m.text }] }))))
  }
  const app = await electron.launch({ cwd, args: ['.'], env: { ...process.env, FENN_BACKGROUND_TEST: '1', FENN_BOT_BACKGROUND: '1', FENN_BOT_TEST: '1', ...(bot ? { FENN_BOT_DATA: data } : { FENN_DATA_DIR: data }) } })
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(10000)
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.locator(bot ? '.bot-app' : '.sidebar').waitFor()
    await page.waitForLoadState('networkidle')
    await resizeViewport(page, { width: 1100, height: 850 })
    if (!bot) await page.locator('.sidebar .nav-item').filter({ hasText: '节点明暗检查' }).click()
    const nodes = page.locator('.conversation-node')
    await nodes.nth(13).waitFor()
    assert.equal(await nodes.count(), 14)
    const settle = () => page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))
    })
    const samples = () => nodes.locator('span').evaluateAll(elements => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d')
      return elements.map(el => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1)
        const color = [...ctx.getImageData(0, 0, 1, 1).data], rect = el.getBoundingClientRect()
        return { color, ink: color.slice(0, 3).reduce((sum, channel) => sum + channel, 0) / 3, width: rect.width, left: rect.left }
      })
    })
    const check = async (peak, theme) => {
      await settle()
      const ticks = await samples()
      assert(ticks.every(tick => tick.color[3] === 255), 'tones use opaque colors instead of multiplying translucent paint')
      const peaks = ticks.map((tick, index) => ({ index, strength: theme === 'light' ? 255 - tick.ink : tick.ink })).sort((a, b) => b.strength - a.strength)
      assert.equal(peaks[0].index, peak)
      assert(peaks[0].strength - peaks[1].strength > 70, JSON.stringify({ kind, theme, peaks }))
      const strength = index => theme === 'light' ? 255 - ticks[index].ink : ticks[index].ink
      for (let d = 1; d <= 3; d++) {
        assert(strength(peak + d) < strength(peak + d - 1))
        assert(Math.abs(ticks[peak - d].ink - ticks[peak + d].ink) <= 1)
        assert(ticks[peak + d].width < ticks[peak + d - 1].width)
      }
      assert(ticks.every(tick => Math.abs(tick.left - ticks[0].left) < .2))
      return ticks
    }
    const report = []
    for (const theme of ['light', 'dark']) {
      await page.evaluate(({ bot, theme }) => bot ? window.bot.configure({ theme }) : window.fenn.updateSettings({ theme }), { bot, theme })
      await nodes.nth(7).hover(); await page.locator('.node-preview').waitFor()
      report.push({ theme, hover: await check(7, theme) })
      const rail = await page.locator('.conversation-nodes').boundingBox()
      const preview = await page.locator('.node-preview').boundingBox()
      await page.screenshot({ path: join(shots, kind + '-' + theme + '.png'), clip: { x: rail.x, y: preview.y - 55, width: preview.x + preview.width - rail.x + 12, height: preview.height + 110 } })
      await nodes.nth(3).focus()
      await nodes.nth(8).hover()
      await check(8, theme)
      await page.keyboard.press('ArrowDown'); await check(9, theme)
      await page.keyboard.press('Escape'); await page.locator('.node-preview').waitFor({ state: 'detached' }); await settle()
      assert((await samples()).every(tick => Math.abs(tick.width - 6) < .2))
    }
    assert.deepEqual(errors, [])
    assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())))
    writeFileSync(join(shots, kind + '-tones.json'), JSON.stringify(report, null, 2))
    console.log('PASS', kind, 'one strongest peak, symmetric gray neighbours, width taper, mixed pointer/keyboard focus, quiet exit; both themes')
  } finally { await app.close() }
}
