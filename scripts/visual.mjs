// Screenshot regression for one standard turn (steps line, answer, a card and
// the action row) in all four looks. Compares against test/visual/*.png;
// UPDATE_VISUAL=1 writes new baselines. Baselines are tied to the fonts of the
// machine that made them (the Linux CI image).
// Usage: xvfb-run -a node scripts/visual.mjs
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareTestAgent } from './test-agent.mjs'

const dir = new URL('../test/visual/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })
const update = !!process.env.UPDATE_VISUAL
const looks = { light: { theme: 'light', glass: false }, dark: { theme: 'dark', glass: false }, glass: { theme: 'dark', glass: true }, 'glass-light': { theme: 'light', glass: true } }
let failed = 0

for (const [name, look] of Object.entries(looks)) {
  const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'oc-visual-')))
  const app = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: data } })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForSelector('.sidebar')
  await page.evaluate(async (l) => {
    localStorage.setItem('oc-lang', 'zh')
    await window.fenn.updateSettings({ language: 'zh', ...l, onboarded: true })
  }, look)
  await page.reload()
  await page.waitForSelector('.sidebar')
  if (await page.locator('.onboarding').count()) await page.click('.onboarding .skip')
  await page.evaluate(() => window.fenn.startChat({ text: '#啰嗦 开子对话 看板上能看到这个讨论串吗？', backendId: 'mock' }))
  await page.click('.sidebar .nav-item >> text=/啰嗦/')
  await page.waitForSelector('.turn .thread-card', { timeout: 20000 })
  await page.waitForSelector('.turn.streaming', { state: 'detached', timeout: 20000 })
  // No caret, no hover fades, no moving mouse: the same pixels every run.
  await page.addStyleTag({ content: '*{transition:none!important;animation:none!important;caret-color:transparent!important}' })
  await page.hover('.turn .md')
  await page.waitForTimeout(400)
  const turn = page.locator('.turn').first()
  const box = await turn.boundingBox()
  const shot = await page.screenshot({ clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 8 + 40 } })
  const file = join(dir, `turn-${name}.png`)
  if (update || !existsSync(file)) {
    writeFileSync(file, shot)
    console.log(`wrote ${file}`)
  } else {
    // Compare in the page itself: decode both images on a canvas and count pixels that differ clearly.
    const diff = await page.evaluate(async ([a, b]) => {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + src })
      const [x, y] = await Promise.all([load(a), load(b)])
      if (x.width !== y.width || x.height !== y.height) return { size: `${x.width}x${x.height} vs ${y.width}x${y.height}` }
      const px = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
      const p = px(x), q = px(y)
      let n = 0
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 48) n++
      return { share: n / (p.length / 4) }
    }, [readFileSync(file).toString('base64'), shot.toString('base64')])
    if (diff.size || diff.share > 0.002) {
      failed++
      writeFileSync(join(dir, `turn-${name}.actual.png`), shot)
      console.log(`✗ ${name}: ${diff.size ?? `${(diff.share * 100).toFixed(2)}% of pixels differ`} (see turn-${name}.actual.png)`)
    } else console.log(`✓ ${name}`)
  }
  await app.close()
}
if (failed) process.exit(1)
