// End-to-end UI checks against the built app, with the demo agent.
// Usage: npm run build && xvfb-run -a node scripts/e2e.mjs [screenshotDir]
// Exits non-zero if any check fails.
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declareTestAgent } from './test-agent.mjs'

const shots = process.argv[2]
const app = await electron.launch({
  args: ['.', '--no-sandbox'],
  env: { ...process.env, FENN_DATA_DIR: declareTestAgent(mkdtempSync(join(tmpdir(), 'oc-e2e-'))) }
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1400, height: 900 })
await page.waitForSelector('.sidebar')
// The checks use Chinese labels, whatever the machine's language.
await page.evaluate(async () => {
  localStorage.setItem('oc-lang', 'zh')
  // Settings keep the language too, and the app makes the two agree on load.
  await window.fenn.updateSettings({ language: 'zh' })
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
    // The first line, and for a wait the selector it waited for (Playwright's call log follows).
    const lines = String(e?.message ?? e).split('\n')
    console.log('✗', name, '\n  ', lines[0], ...(lines.find((l) => /waiting for/.test(l)) ? ['\n  ', lines.find((l) => /waiting for/.test(l)).trim()] : []))
  }
  if (shots) await page.screenshot({ path: join(shots, `e2e-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
}
/** Opens the thread a forwarded line points to. The line moves when the thread card above it changes (its step line comes and goes as the thread works), so a click a move made miss is tried again. */
const openForwarded = async (line) => {
  await page.click(line)
  for (let i = 0; i < 5 && !(await page.locator('.panel .thread-view').count()); i++) {
    await page.waitForTimeout(300)
    await page.click(line)
  }
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
    // A pane that is still sliding in moves its handle away from where it was measured.
    await page.locator(sel).locator('..').evaluate((el) =>
      Promise.allSettled(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)))
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
  // Frames come late on a loaded machine (the Ubuntu runner): what is typed right after picking
  // must stay in order, not be split by a caret put back a frame later.
  await page.evaluate(() => {
    const raf = (window.__raf = window.requestAnimationFrame)
    window.requestAnimationFrame = (f) => raf(() => setTimeout(() => f(performance.now()), 150))
  })
  await page.keyboard.press('Enter')
  await page.waitForSelector('.mention-chip:has-text("调研竞品定价")')
  await page.keyboard.type('再加一家 D 公司', { delay: 30 })
  await page.evaluate(() => (window.requestAnimationFrame = window.__raf))
  const typed = await page.inputValue('.center .workspace > .center .composer textarea')
  if (typed !== '再加一家 D 公司') throw new Error('typed after picking: ' + JSON.stringify(typed))
  await page.keyboard.press('Enter')
  await page.waitForSelector('.thread-event.kind-forwarded:has-text("已转给「调研竞品定价」：再加一家 D 公司")', { timeout: 5000 })
  if (await page.locator('.mention-chip').count()) throw new Error('chip stayed after sending')
  if (await page.locator('.center .workspace > .center .msg-user:has-text("再加一家")').count()) throw new Error('the message also went to the coordinator')
  await openForwarded('.thread-event.kind-forwarded')
  // It reaches the thread at once: waiting while the thread's first reply is still running (slow runners), then sent.
  await page.waitForSelector('.panel .msg-user:has-text("再加一家 D 公司"), .panel .queue-row:has-text("再加一家 D 公司")', { timeout: 5000 })
  await page.waitForSelector('.panel .msg-user:has-text("再加一家 D 公司")', { timeout: 30000 })
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
  await openForwarded('.thread-event.kind-forwarded >> nth=-1')
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

await check('embedded select stays still while the mouse is held and released in a long reply', async () => {
  await page.click('.nav-item:has-text("新建")')
  await send('做个可视化 #慢页面')
  const inline = page.locator('.interactive-preview').last()
  const frame = inline.frameLocator('iframe')
  const select = frame.locator('#edge-left')
  await select.waitFor()
  await select.evaluate((el) => {
    const root = document.querySelector('[data-fenn-ui]')
    const before = document.createElement('div'), after = document.createElement('div')
    before.style.height='800px';after.style.height='900px'
    root.prepend(before);root.append(after)
    for(let i=0;i<10;i++)el.add(new Option('Model '+i,String(i)))
  })
  await page.waitForFunction(()=>document.querySelector('.interactive-preview iframe')?.getBoundingClientRect().height>1700)
  const scroll = page.locator('.scroll:has(> .transcript)')
  await scroll.dispatchEvent('wheel')
  const box = await select.boundingBox()
  await scroll.evaluate((el,y)=>el.scrollTop+=y-el.clientHeight/2,box.y)
  await page.waitForTimeout(200)
  // Record every rendered frame; an after-click screenshot misses transient jumps.
  await page.evaluate(()=>{
    window.pickerPositions=[];window.recordPicker=true
    const record=()=>{
      const el=document.querySelector('.scroll:has(> .transcript)'),r=document.querySelector('.interactive-preview iframe').getBoundingClientRect()
      window.pickerPositions.push({scroll:el.scrollTop,top:r.top,height:r.height})
      if(window.recordPicker)requestAnimationFrame(record)
    };record()
  })
  await select.evaluate((el)=>{
    window.pickerPositions=[];window.recordPicker=true
    const record=()=>{
      const root=document.querySelector('[data-fenn-ui]')
      window.pickerPositions.push({scroll:scrollY,top:el.getBoundingClientRect().top,height:root.getBoundingClientRect().height,overflow:root.scrollHeight})
      if(window.recordPicker)requestAnimationFrame(record)
    };record()
  })
  const target=await select.boundingBox()
  await page.mouse.move(target.x+target.width/2,target.y+target.height/2)
  await page.mouse.down()
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.locator('.menu').waitFor()
  await page.locator('.menu').evaluate(el=>el.scrollTop=120)
  await page.waitForTimeout(100)
  if(!await page.locator('.menu').isVisible())throw new Error('Scrolling choices must not close the picker')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  await select.press('Space')
  await page.locator('.menu').waitFor()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  if(await select.inputValue()!=='Sol')throw new Error('Keyboard selection must update the real select')
  const outer=await page.evaluate(()=>{window.recordPicker=false;return window.pickerPositions})
  const inner=await select.evaluate(()=>{window.recordPicker=false;return window.pickerPositions})
  for(const [name,samples] of [['outer',outer],['inner',inner]]){
    const first=samples[0]
    if(samples.some(s=>Math.abs(s.scroll-first.scroll)>1||Math.abs(s.top-first.top)>1||Math.abs(s.height-first.height)>1))
      throw new Error('Select moved '+name+' page during pointer press: '+JSON.stringify({outer:[...new Set(outer.map(s=>JSON.stringify(s)))],inner:[...new Set(inner.map(s=>JSON.stringify(s)))]}))
  }
})

await check('threshold annotations reserve a lane instead of overlapping the preceding title', async () => {
  await page.click('.nav-item:has-text("新建")')
  await send('#标注重叠')
  const pane=page.locator('.page-panel'),frame=pane.frameLocator('iframe')
  await frame.locator('#limit').waitFor()
  const measure=()=>frame.locator('.row').evaluate(row=>{
    const textRect=el=>{const range=document.createRange();range.selectNodeContents(el);return range.getBoundingClientRect()}
    const title=textRect(row.querySelector('h3')),label=textRect(row.querySelector('#limit')),bar=row.querySelector('.track').getBoundingClientRect(),note=row.querySelector('.note').getBoundingClientRect()
    return {titleBottom:title.bottom,labelTop:label.top,labelBottom:label.bottom,barTop:bar.top,barBottom:bar.bottom,noteTop:note.top,margin:parseFloat(getComputedStyle(row.querySelector('.track')).marginTop)}
  })
  for(const size of [16,24,16]){
    await frame.locator('body').evaluate((el,size)=>el.style.fontSize=size+'px',size)
    await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    const m=await measure()
    if(m.labelTop<m.titleBottom+4||m.barTop<m.labelBottom||m.noteTop<m.barBottom)throw new Error('Threshold annotation overlaps: '+JSON.stringify(m))
  }
  const badge=await frame.locator('.badge').evaluate(el=>el.style.cssText)
  await frame.locator('#update').click()
  await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  const updated=await measure()
  if(updated.labelTop<updated.titleBottom+4)throw new Error('Updated threshold overlaps the title: '+JSON.stringify(updated))
  await frame.locator('body').evaluate(()=>new Promise(r=>{let n=0;const tick=()=>++n===12?r():requestAnimationFrame(tick);tick()}))
  if(Math.abs((await measure()).margin-updated.margin)>1)throw new Error('Annotation spacing must not accumulate on observer callbacks')
  await frame.locator('.marker').evaluate(el=>el.style.left='80%')
  await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  if((await measure()).margin!==0)throw new Error('Collision-free labels must release the extra spacing')
  await frame.locator('.marker').evaluate(el=>el.style.left='4%')
  await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  for(const width of [900,640,1400]){
    await page.setViewportSize({width,height:900})
    await frame.locator('body').evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
    const m=await measure()
    if(m.labelTop<m.titleBottom+4||m.noteTop<m.barBottom)throw new Error('Annotation collision after window resize: '+JSON.stringify(m))
  }
  if(await frame.locator('.badge').evaluate(el=>el.style.cssText)!==badge)throw new Error('Unrelated positioned elements must not be rewritten')
  if(shots){await page.screenshot({path:join(shots,'threshold-annotation-lanes.png')});await frame.locator('.row').screenshot({path:join(shots,'threshold-annotation-row.png')})}
})

await check('legacy full HTML pages use an aligned host picker instead of the native popup', async () => {
  await page.click('.nav-item:has-text("新建")')
  await send('#旧下拉')
  const pane=page.locator('.page-panel'),frame=pane.frameLocator('iframe'),select=frame.locator('#legacy-select')
  await select.waitFor()
  const before=await select.boundingBox()
  await select.click()
  const menu=page.locator('.menu')
  await menu.waitFor({timeout:3000})
  await menu.evaluate(el=>Promise.allSettled(el.getAnimations().map(a=>a.finished)))
  const after=await select.boundingBox(),box=await menu.boundingBox()
  if(Math.abs(before.y-after.y)>1||Math.abs(box.x-after.x)>1||Math.abs(box.width-after.width)>1||box.y<after.y+after.height)
    throw new Error('Legacy picker shifted or overlaps its control: '+JSON.stringify({before,after,box}))
  if(shots)await page.screenshot({path:join(shots,'legacy-picker-open.png')})
  await page.getByRole('menuitemradio',{name:'MiMo V2.6 Pro',exact:true}).click()
  if(await select.inputValue()!=='MiMo V2.6 Pro')throw new Error('Legacy page selection did not apply')
  if(shots)await page.screenshot({path:join(shots,'legacy-picker-after-select.png')})
})

await check('legacy inline page size messages do not pull unpadded content up or left', async () => {
  await page.click('.nav-item:has-text("新建")')
  await send('#旧下拉 内联')
  const inline=page.locator('.interactive-preview').last(),frame=inline.frameLocator('iframe')
  await frame.locator('#legacy-select').waitFor()
  await frame.locator('body').evaluate(()=>parent.postMessage({type:'fenn:ui-size',height:320},'*'))
  await page.waitForFunction(()=>[...document.querySelectorAll('.interactive-preview iframe')].at(-1).getBoundingClientRect().height===320)
  const geometry=await inline.evaluate(el=>{
    const outer=el.getBoundingClientRect(),surface=el.querySelector('.artifact-surface').getBoundingClientRect()
    return {top:surface.top-outer.top,left:surface.left-outer.left,padded:el.querySelector('.artifact-surface').classList.contains('ui-padded')}
  })
  if(geometry.padded||Math.abs(geometry.top)>1||Math.abs(geometry.left)>1)throw new Error('Unpadded legacy page was shifted: '+JSON.stringify(geometry))
  if(shots)await page.screenshot({path:join(shots,'legacy-inline-no-offset.png')})
})

await check('charts render offline, fit narrow replies and keep data accessible', async () => {
  const errors=[]
  const onError=e=>errors.push(e.message)
  page.on('pageerror',onError)
  try{
    await page.click('.nav-item:has-text("新建")')
    await send('#折线图')
    const inline=page.locator('.interactive-preview').last(), frame=inline.frameLocator('iframe'), canvas=frame.locator('canvas')
    await canvas.waitFor()
    for(const [theme,width,height] of [['light',1400,900],['dark',860,650],['light',640,600]]){
      await page.evaluate(theme=>window.fenn.updateSettings({theme}),theme)
      await page.setViewportSize({width,height})
      await canvas.evaluate(el=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
      const layout=await canvas.evaluate(el=>{
        const c=Chart.getChart(el),r=el.getBoundingClientRect()
        return {type:c?.config.type,datasets:c?.data.datasets.length,left:r.left,right:r.right,width:innerWidth,height:r.height,missing:c?.data.datasets[0].data[2]}
      })
      if(layout.type!=='line'||layout.datasets!==2||layout.missing!==null||layout.left<0||layout.right>layout.width+1||layout.height<200)throw new Error('Chart layout/data incorrect: '+JSON.stringify(layout))
      await canvas.focus()
      await canvas.press('ArrowRight')
      if(!await canvas.evaluate(el=>Chart.getChart(el).tooltip.opacity>0))throw new Error('Chart keyboard tooltip did not open')
      await canvas.press('Escape')
      await frame.locator('summary').click()
      if(await frame.locator('tbody tr, table tr').count()!==7)throw new Error('Chart data table is incomplete')
      await frame.locator('summary').click()
      if(shots)await page.screenshot({path:join(shots,`chart-${theme}-${width}.png`)})
    }
    await send('#柱状图')
    const bar=page.locator('.interactive-preview').last().frameLocator('iframe').locator('canvas')
    await bar.waitFor()
    if(await bar.evaluate(el=>Chart.getChart(el)?.config.type)!=='bar')throw new Error('Bar chart did not render')
    if(errors.length)throw new Error('Chart runtime errors: '+errors.join('; '))
  }finally{
    page.off('pageerror',onError)
    await page.setViewportSize({width:1400,height:900})
  }
})

await check('interactive pages work inline and expand into a clipped responsive preview pane', async () => {
  await page.click('.nav-item:has-text("新建")')
  await page.fill('.composer textarea', '做个可视化 #慢页面')
  await page.keyboard.press('Enter')
  await page.locator('.working-mark').filter({ hasText: '正在制作可视化…' }).waitFor()
  await page.locator('.working-mark .fox-mark.thinking').waitFor()
  const inline = page.locator('.interactive-preview').last()
  await inline.waitFor()
  if (await inline.locator('.interactive-head, .interactive-title').count()) throw new Error('Embedded UI must not have a webpage toolbar')
  await page.waitForSelector('.turn.streaming', { state: 'detached', timeout: 20000 })
  if (await page.locator('.page-panel').count()) throw new Error('An inline result must not open the side pane')
  const small = inline.frameLocator('iframe')
  await small.locator('#b').click()
  if ((await small.locator('#n').innerText()) !== '1') throw new Error('Inline JavaScript did not run')
  await page.waitForFunction(() => document.querySelector('.interactive-preview iframe')?.getBoundingClientRect().height < 300)
  const collapsedHeight = await inline.locator('iframe').evaluate((el) => el.getBoundingClientRect().height)
  await small.getByRole('button', { name: '展开说明' }).click()
  await page.waitForFunction((before) => document.querySelector('.interactive-preview iframe').getBoundingClientRect().height > before + 50, collapsedHeight)
  await small.getByRole('button', { name: '展开说明' }).click()
  await page.waitForFunction((before) => Math.abs(document.querySelector('.interactive-preview iframe').getBoundingClientRect().height - before) < 2, collapsedHeight)
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => window.fenn.updateSettings({ theme }), theme)
    await small.locator('body').evaluate(() => document.body.offsetHeight)
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme)
    await small.locator('body').evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const colors = await small.locator('body').evaluate(() => ({ text: getComputedStyle(document.body).color, declared: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() }))
    const expected = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text').trim())
    if (colors.declared !== expected) throw new Error('Embedded UI must follow the conversation theme')
    if ((await small.locator('#n').innerText()) !== '1') throw new Error('Theme change must not restart the UI')
  }
  await page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).every((a) => !a.pending && a.playState !== 'running'))
  if (shots) await page.screenshot({ path: join(shots, 'embedded-in-reply.png') })

  for (const selector of ['#edge-left', '#edge-right']) {
    await page.keyboard.press('Tab')
    await small.locator(selector).focus()
    const paint = await small.locator(selector).evaluate((el) => {
      const r = el.getBoundingClientRect(), css = getComputedStyle(el)
      const extra = Math.max(0, parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset))
      return { left: r.left-extra, right: r.right+extra, top: r.top-extra, bottom:r.bottom+extra, width:innerWidth, height:innerHeight, radius:parseFloat(css.borderRadius) }
    })
    if (paint.left < 0 || paint.top < 0 || paint.right > paint.width || paint.bottom > paint.height || paint.radius <= 0) throw new Error('Rounded focus outline is clipped: ' + JSON.stringify(paint))
  }
  const proseLeft = await inline.evaluate((el) => el.parentElement.querySelector('.md').getBoundingClientRect().left)
  const controlsLeft = (await small.locator('.demo-grid').boundingBox()).x
  if (Math.abs(proseLeft-controlsLeft)>1) throw new Error(`Embedded controls shifted from prose: ${proseLeft} vs ${controlsLeft}`)
  if(shots) await page.screenshot({path:join(shots,'rounded-focus-in-reply.png')})

  // The shared app menu lives outside the iframe, aligned to the actual control.
  for (const selector of ['#edge-left', '#edge-right']) {
    const select = small.locator(selector)
    if (selector === '#edge-right') await select.evaluate((el) => {
      for (let i=0;i<12;i++) el.add(new Option('Another model choice '+i, String(i)))
    })
    await select.click()
    const menu=page.locator('.menu')
    await menu.waitFor()
    await menu.evaluate(el=>Promise.allSettled(el.getAnimations().map(a=>a.finished)))
    const picker = await menu.boundingBox(), control=await select.boundingBox()
    if (Math.abs(picker.width-control.width)>1 || Math.abs(picker.x-control.x)>1 || picker.y<0 || picker.y+picker.height>900)
      throw new Error('Embedded select popup is misaligned: '+JSON.stringify({picker,control}))
    if (selector === '#edge-right' && picker.height<100) throw new Error('A long picker must show several choices, not a single cramped row')
    if (shots) await page.screenshot({path:join(shots,`aligned-picker-${selector.slice(1)}.png`)})
    await page.keyboard.press('Escape')
    await menu.waitFor({state:'detached'})
  }
  await small.locator('#edge-left').evaluate((el) => el.addEventListener('change',()=>el.dataset.changed='yes'))
  await small.locator('#edge-left').click()
  await page.locator('.menu-item').filter({hasText:'Sol'}).click()
  if (await small.locator('#edge-left').inputValue() !== 'Sol') throw new Error('Select value must remain available to generated UI code')
  if (await small.locator('#edge-left').getAttribute('data-changed') !== 'yes') throw new Error('Selecting an option must notify generated UI code')

  const isolated = await small.locator('body').evaluate(() => {
    try { void parent.document.body; return false } catch { return true }
  })
  if (!isolated) throw new Error('Generated HTML must be isolated from the app')
  await inline.getByRole('button', { name: '在侧栏展开' }).click()
  const pane = page.locator('.page-panel')
  await pane.waitFor()
  await pane.frameLocator('iframe').locator('#b').click()
  if ((await pane.frameLocator('iframe').locator('#n').innerText()) !== '1') throw new Error('Expanded JavaScript did not run')
  for (const [theme, width, height] of [['light', 1400, 900], ['dark', 860, 560]]) {
    await page.evaluate((theme) => window.fenn.updateSettings({ theme }), theme)
    await page.setViewportSize({ width, height })
    await page.waitForFunction(() => {
      const pane = document.querySelector('.page-panel')
      const frame = pane?.querySelector('iframe')
      const head = pane?.querySelector('.panel-head')
      if (!pane || !frame || !head) return false
      const p = pane.getBoundingClientRect(), f = frame.getBoundingClientRect(), h = head.getBoundingClientRect()
      const css = getComputedStyle(pane)
      return p.left >= 0 && p.right <= innerWidth && p.bottom <= innerHeight &&
        parseFloat(css.borderTopLeftRadius) > 0 && css.overflow === 'hidden' &&
        Math.abs(f.top - h.bottom) <= 1 && f.bottom <= p.bottom && f.height > 100 &&
        head.scrollWidth <= head.clientWidth
    })
    if (shots) await page.screenshot({ path: join(shots, `interactive-${theme}-${width}.png`) })
  }
  await pane.getByRole('button', { name: '放大预览', exact: true }).click()
  await page.locator('.page-panel.maximized').waitFor()
  await pane.getByRole('button', { name: '还原预览', exact: true }).click()
  await pane.getByRole('button', { name: '查看代码', exact: true }).click()
  if (!(await pane.locator('.page-code').innerText()).includes('计数器')) throw new Error('Missing page source')
  await pane.getByRole('button', { name: '预览', exact: true }).click()
  await pane.frameLocator('iframe').locator('#b').waitFor()
  await pane.getByRole('button', { name: '关闭', exact: true }).click()
  await pane.waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 1400, height: 900 })
  await send('改一下可视化 侧栏')
  await pane.waitFor()
  await pane.frameLocator('iframe').getByText('计数器 v2', { exact: true }).waitFor()
  await pane.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => window.fenn.updateSettings({ theme: 'system' }))
})

await check('appearance offers only opaque light, dark and system themes', async () => {
  const original = await page.evaluate(async () => (await window.fenn.snapshot()).settings.theme)
  for (const theme of ['light', 'dark', 'system']) {
    await page.evaluate((theme) => window.fenn.updateSettings({ theme }), theme)
    await page.waitForFunction((theme) => document.documentElement.dataset.theme ===
      (theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme), theme)
    const surface = await page.evaluate(() => {
      const css = getComputedStyle(document.body)
      return { background: css.backgroundColor, blur: css.backdropFilter }
    })
    if (!/^rgb\(/.test(surface.background) || surface.blur !== 'none') throw new Error(JSON.stringify(surface))
  }
  await page.click('.user-btn')
  await page.click('.settings-nav .nav-item:has-text("外观")')
  const settings = page.locator('.settings-body')
  if (/玻璃|Glass/i.test(await settings.innerText())) throw new Error('Retired appearance control still visible')
  await page.keyboard.press('Escape')
  await page.evaluate((theme) => window.fenn.updateSettings({ theme }), original)
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

await check('自定义指令 in Settings saves as typed, even when Settings closes with Esc', async () => {
  await page.click('.user-btn')
  await page.click('.settings-nav .nav-item:has-text("通用")')
  const box = page.locator('.field:has(label:text-is("自定义指令")) textarea')
  await box.fill('回答简短一些')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.overlay', { state: 'detached', timeout: 2000 })
  for (let i = 0; (await page.evaluate(() => window.fenn.snapshot().then((s) => s.settings.customInstructions))) !== '回答简短一些'; i++) {
    if (i > 30) throw new Error('自定义指令 was not saved')
    await page.waitForTimeout(100)
  }
  if (shots) {
    await page.click('.user-btn')
    await page.click('.settings-nav .nav-item:has-text("通用")')
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(shots, 'settings-instructions.png') })
    await page.keyboard.press('Escape')
  }
  await page.evaluate(() => window.fenn.updateSettings({ customInstructions: '' }))
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
  const saved = await page.evaluate(() => window.fenn.snapshot().then((s) => s.settings.userName))
  if (saved !== 'E2E 名字') throw new Error('name not saved on close: ' + saved)
  await page.evaluate(() => window.fenn.updateSettings({ userName: '' }))
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

await check('the files panel makes, autosaves, renames, shows full screen and deletes a file (取消 focused)', async () => {
  const pane = page.locator('.side-pane .files-pane')
  const back = async () => { if (await pane.locator('.preview-head .icon-btn[aria-label="返回文件列表"]').count()) await pane.locator('.preview-head .icon-btn[aria-label="返回文件列表"]').click() }
  const root = await page.evaluate(async () => {
    const s = await window.fenn.snapshot()
    const c = s.conversations.find((x) => x.cwd && !x.projectId)
    return (await window.fenn.listLibrary(c.id)).root
  })
  await pane.locator('.files-head .icon-btn[aria-label="新建或添加文件"]').click()
  await page.click('.menu .menu-item:has-text("新建文件")')
  await pane.locator('.tree-input').fill('草稿.md')
  await page.keyboard.press('Enter')
  const editor = pane.locator('.preview-editor')
  await editor.waitFor({ timeout: 3000 })
  await editor.fill('# 标题\n\n正文')
  // Saved by itself after a pause, with no 取消/保存 to press.
  await pane.locator('.preview-head .small:has-text("已保存")').waitFor({ timeout: 3000 })
  if (readFileSync(join(root, '草稿.md'), 'utf8') !== '# 标题\n\n正文') throw new Error('not saved to disk')
  if (await pane.locator('.preview-head .btn:has-text("取消"), .preview-head .btn:has-text("保存")').count()) throw new Error('取消/保存 still shown')
  if (await pane.locator('.preview-head .icon-btn[aria-label="编辑"]').count()) throw new Error('an edit button is still shown')
  // Typing and switching to 预览 at once still saves; 预览 is read only.
  await editor.press('Control+End')
  await page.keyboard.type('。')
  await pane.locator('.preview-head .seg-control button:has-text("预览")').click()
  await pane.locator('.preview-md h1:has-text("标题")').waitFor({ timeout: 3000 })
  if (await pane.locator('.preview-editor').count()) throw new Error('预览 can be typed in')
  await page.waitForFunction(() => document.querySelector('.files-pane .preview-head .small')?.textContent?.includes('已保存'), null, { timeout: 3000 })
  if (readFileSync(join(root, '草稿.md'), 'utf8') !== '# 标题\n\n正文。') throw new Error('not saved on leaving the source')
  // Full screen shows the same file; Esc comes back.
  await pane.locator('.preview-head .icon-btn[aria-label="全屏"]').click()
  await page.locator('.modal.file-full .preview-md h1:has-text("标题")').waitFor({ timeout: 3000 })
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal.file-full', { state: 'detached', timeout: 2000 })
  await back()
  // F2 renames in place.
  await pane.locator('.tree-row:has-text("草稿.md")').focus()
  await page.keyboard.press('F2')
  await pane.locator('.tree-input').fill('定稿.md')
  await page.keyboard.press('Enter')
  await pane.locator('.tree-row:has-text("定稿.md")').waitFor({ timeout: 3000 })
  if (!existsSync(join(root, '定稿.md')) || existsSync(join(root, '草稿.md'))) throw new Error('not renamed on disk')
  // Delete asks first, with 取消 focused.
  await back()
  await pane.locator('.tree-item:has-text("定稿.md")').click({ button: 'right' })
  await page.click('.menu .menu-item:has-text("删除")')
  await page.waitForSelector('.modal.confirm')
  if (!(await page.evaluate(() => document.activeElement?.classList.contains('confirm-cancel')))) throw new Error('取消 is not focused')
  await page.click('.modal.confirm .btn.danger-solid')
  await pane.locator('.tree-row:has-text("定稿.md")').waitFor({ state: 'detached', timeout: 3000 })
  if (existsSync(join(root, '定稿.md'))) throw new Error('still on disk')
})

await check('autosave keeps a file’s CRLF line ends, an agent’s change is never overwritten unasked; GBK files are view only; Tab stays in the full-screen editor', async () => {
  const pane = page.locator('.side-pane .files-pane')
  const back = async () => { if (await pane.locator('.preview-head .icon-btn[aria-label="返回文件列表"]').count()) await pane.locator('.preview-head .icon-btn[aria-label="返回文件列表"]').click() }
  const root = await page.evaluate(async () => {
    const s = await window.fenn.snapshot()
    const c = s.conversations.find((x) => x.cwd && !x.projectId)
    return (await window.fenn.listLibrary(c.id)).root
  })
  writeFileSync(join(root, 'win.txt'), 'one\r\ntwo\r\n')
  writeFileSync(join(root, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
  await pane.locator('.files-head .icon-btn[aria-label="刷新"]').click()
  await pane.locator('.tree-row:has-text("gbk.txt")').click()
  await pane.locator('.preview-head .small:has-text("只能查看")').waitFor({ timeout: 3000 })
  if (await pane.locator('.preview-editor').count()) throw new Error('a GBK file can be edited')
  await back()
  // A file open in a narrow pane: + → 新建文件 still shows the name field.
  await pane.locator('.files-head .icon-btn[aria-label="新建或添加文件"]').click()
  await page.click('.menu .menu-item:has-text("新建文件")')
  await pane.locator('.tree-input').waitFor({ timeout: 2000 })
  await page.keyboard.press('Escape')
  // A text file opens ready to type in.
  await pane.locator('.tree-row:has-text("win.txt")').click()
  const editor = pane.locator('.preview-editor')
  await editor.waitFor({ timeout: 3000 })
  await editor.press('Control+End')
  await page.keyboard.type('three')
  await page.keyboard.press('Control+s')
  await pane.locator('.preview-head .small:has-text("已保存")').waitFor({ timeout: 3000 })
  if (readFileSync(join(root, 'win.txt'), 'utf8') !== 'one\r\ntwo\r\nthree') throw new Error('line ends changed: ' + JSON.stringify(readFileSync(join(root, 'win.txt'), 'utf8')))
  // An agent writes the file meanwhile: the next save asks which version to keep.
  await new Promise((r) => setTimeout(r, 50))
  writeFileSync(join(root, 'win.txt'), 'agent\r\n')
  utimesSync(join(root, 'win.txt'), new Date(), new Date(Date.now() + 5000))
  await page.keyboard.type('!')
  await pane.locator('.preview-conflict').waitFor({ timeout: 3000 })
  if (readFileSync(join(root, 'win.txt'), 'utf8') !== 'agent\r\n') throw new Error('the agent’s change was overwritten')
  await pane.locator('.preview-conflict .pill-btn:has-text("保留我的版本")').click()
  await pane.locator('.preview-conflict').waitFor({ state: 'detached', timeout: 3000 })
  if (readFileSync(join(root, 'win.txt'), 'utf8') !== 'one\r\ntwo\r\nthree!') throw new Error('not kept: ' + JSON.stringify(readFileSync(join(root, 'win.txt'), 'utf8')))
  await pane.locator('.preview-head .icon-btn[aria-label="全屏"]').click()
  const full = page.locator('.modal.file-full .preview-editor')
  await full.waitFor({ timeout: 2000 })
  await full.focus()
  await page.keyboard.press('Tab')
  if (!(await full.evaluate((el) => el === document.activeElement && el.value.includes('\t')))) throw new Error('Tab left the editor')
  // Esc leaves full screen, nothing asks, and the tab is saved.
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.modal.file-full'), null, { timeout: 2000 })
  for (let i = 0; i < 30 && !readFileSync(join(root, 'win.txt'), 'utf8').includes('\t'); i++) await new Promise((r) => setTimeout(r, 100))
  if (!readFileSync(join(root, 'win.txt'), 'utf8').includes('\t')) throw new Error('the tab was not saved')
  // Moved away while open: a bar keeps what was typed and puts it back on request.
  await editor.click()
  await editor.press('Control+End')
  await page.keyboard.type('moved')
  renameSync(join(root, 'win.txt'), join(root, 'win-old.txt'))
  await pane.locator('.preview-conflict:has-text("移走")').waitFor({ timeout: 3000 })
  await pane.locator('.preview-conflict .pill-btn:has-text("在原位置重新保存")').click()
  await pane.locator('.preview-conflict').waitFor({ state: 'detached', timeout: 3000 })
  if (!readFileSync(join(root, 'win.txt'), 'utf8').endsWith('moved')) throw new Error('not saved again where it was')
  await page.waitForSelector('.modal.file-full', { state: 'detached', timeout: 2000 })
  await back()
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
  const child = await page.evaluate(async () => (await window.fenn.snapshot()).conversations.find((c) => c.parentId && c.handoff?.task === '整理一下日志'))
  if (!child) throw new Error('no sub-chat with that task')
  if (!child.handoff.context?.includes('计划.md')) throw new Error('the sub-chat got no context from this chat')
  if (!(await page.locator('.center .bubble .cmd-token:has-text("/子对话")').count())) throw new Error('the sent command is not shown as a token')
  await page.waitForTimeout(800)
  const replies = await page.evaluate(async (id) => (await window.fenn.messages(id)).filter((m) => m.role === 'assistant').length, child.parentId)
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
  const id = await page.evaluate(async () => (await window.fenn.snapshot()).conversations.find((c) => !c.parentId && !c.projectId)?.id)
  if (!id) throw new Error('no chat to rename')
  await page.evaluate((id) => window.fenn.send(id, '/rename 发布清单'), id)
  await page.waitForFunction(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.title === '发布清单', id, { timeout: 8000 })
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
    // Both measured in the same frame: the button may have moved since the click, and the menu
    // follows it one frame later, so a miss is measured again a few times before it counts.
    for (let tries = 0; ; tries++) {
      const [b, m] = await page.evaluate((el) => [el.getBoundingClientRect(), document.querySelector('.menu').getBoundingClientRect()].map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })), btn)
      const vp = page.viewportSize()
      const vertical = Math.min(Math.abs(m.y - (b.y + b.height)), Math.abs(m.y + m.height - b.y))
      const horizontal = Math.min(Math.abs(m.x - b.x), Math.abs(m.x + m.width - (b.x + b.width)))
      const ok = !(vertical > 12 || horizontal > 12 || m.x < 0 || m.y < 0 || m.x + m.width > vp.width || m.y + m.height > vp.height)
      if (ok) break
      if (tries >= 5) throw new Error(`${label}: menu at ${Math.round(m.x)},${Math.round(m.y)} but button at ${Math.round(b.x)},${Math.round(b.y)}`)
      await page.waitForTimeout(60)
    }
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

await check('stopping a reply leaves one quiet 已停止 under it, and the button is 发送 again', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.fill('.composer textarea', '讲一个很长的故事')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.working-mark', { timeout: 10000 })
  const stop = page.locator('.composer .send-btn.stop')
  if ((await stop.getAttribute('aria-label')) !== '停止') throw new Error('the stop button is named ' + (await stop.getAttribute('aria-label')))
  await stop.click()
  const note = page.locator('.turn').last().locator('.turn-note.stopped')
  await note.waitFor({ timeout: 10000 })
  if ((await note.innerText()).trim() !== '已停止') throw new Error('reads: ' + (await note.innerText()))
  if ((await page.locator('.turn').last().locator('.turn-note, .msg-error').count()) !== 1) throw new Error('more than one end note')
  const send = page.locator('.composer .send-btn')
  await page.waitForSelector('.composer .send-btn:not(.stop)', { timeout: 5000 })
  if ((await send.getAttribute('aria-label')) !== '发送') throw new Error('the idle button is named ' + (await send.getAttribute('aria-label')))
})

await check('a chat shows its plan under the title, opening to the full plan and obstacles', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await send('#难点 文档和接口对不上 先看看')
  const line = page.locator('.plan-line')
  await line.waitFor({ timeout: 5000 })
  const summary = await line.locator('.plan-summary').innerText()
  if (!summary.includes('3/3') || !summary.includes('难点') || summary.includes('文档和接口对不上')) throw new Error('plan line reads: ' + summary)
  await line.locator('.plan-summary').click()
  await line.locator('.plan-body .checklist').waitFor({ timeout: 2000 })
  if (!(await line.locator('.plan-current-blocker').innerText()).includes('文档和接口对不上')) throw new Error('current obstacle missing')
  if ((await line.locator('.plan-summary').innerText()).includes('难点')) throw new Error('Expanded obstacle is repeated in the summary')
  for (const [width,height] of [[1400,900],[860,560]]) {
    await page.setViewportSize({width,height})
    await page.waitForFunction(() => {
      const p = document.querySelector('.plan-line'), t = document.querySelector('.transcript')
      if (!p||!t) return false
      const r = p.getBoundingClientRect(), tr = t.getBoundingClientRect(), css = getComputedStyle(t)
      return Math.abs(r.left-(tr.left+parseFloat(css.paddingLeft)))<=1 && Math.abs(r.right-(tr.right-parseFloat(css.paddingRight)))<=1
    })
  }
  await page.setViewportSize({width:1400,height:900})

  const position = () => line.locator('.plan-blocker').evaluate((el) => ({ x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width }))
  let shortPosition
  for (const text of ['#计划短', '#计划长']) {
    await send(text)
    await line.locator('.plan-body').waitFor()
    if ((await line.locator('.plan-summary .plan-text').innerText()) !== '计划') throw new Error('Expanded plan repeats the current step')
    await line.locator('.plan-summary').click()
    if (text === '#计划短') shortPosition = await position()
    else if (JSON.stringify(await position()) !== JSON.stringify(shortPosition)) throw new Error('The obstacle shifts with the preceding step length')
  }
})

await check('a chat can be renamed from the sidebar', async () => {
  const row = page.locator('.sidebar .nav-item.selected')
  await row.hover()
  await row.locator('.trail .icon-btn').click()
  await page.click('.menu-item:has-text("重命名")')
  // Renamed in the row itself: focus starts in the field with the old name selected, so typing replaces it.
  await row.locator('input.rename-input').waitFor({ timeout: 2000 })
  await page.waitForFunction(() => document.activeElement?.matches('.sidebar .nav-item input.rename-input'), null, { timeout: 2000 })
  if (await page.locator('.modal').count()) throw new Error('rename opened a dialog')
  await page.keyboard.type('接口排查')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.sidebar .nav-item.selected:has-text("接口排查")', { timeout: 3000 })
})

await check('a double click on a title renames it in place: Enter keeps, Esc, an empty name and IME keys do not', async () => {
  const row = page.locator('.sidebar .nav-item.selected')
  const id = await page.evaluate(async () => (await window.fenn.snapshot()).conversations.find((c) => c.title === '接口排查')?.id)
  if (!id) throw new Error('no chat named 接口排查')
  const title = async () => page.evaluate(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.title, id)
  const field = row.locator('input.rename-input')
  const open = async () => {
    await row.locator('.label').dblclick()
    await field.waitFor({ timeout: 2000 })
  }
  await open()
  if ((await field.inputValue()) !== '接口排查') throw new Error('the field holds ' + (await field.inputValue()))
  const sel = await field.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length])
  if (sel[0] !== 0 || sel[1] !== sel[2]) throw new Error('the old name is not selected: ' + sel)
  if (await page.locator('.modal, .menu').count()) throw new Error('the double click also opened something else')
  // A key the input method is still composing neither saves nor cancels.
  await field.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true }))
  })
  if (!(await field.count())) throw new Error('an IME key ended the rename')
  await page.keyboard.type('文档核对')
  await page.keyboard.press('Enter')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  await page.waitForSelector('.sidebar .nav-item.selected .label:text-is("文档核对")', { timeout: 3000 })
  await page.waitForFunction(async (id) => (await window.fenn.snapshot()).conversations.find((c) => c.id === id)?.title === '文档核对', id, { timeout: 3000 })
  // Esc puts the old name back.
  await open()
  await page.keyboard.type('不要这个')
  await page.keyboard.press('Escape')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  if ((await row.locator('.label').innerText()) !== '文档核对') throw new Error('Esc kept the new name')
  // So does an empty name.
  await open()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await field.waitFor({ state: 'detached', timeout: 2000 })
  await page.waitForTimeout(200)
  if ((await title()) !== '文档核对') throw new Error('an empty name was saved as ' + JSON.stringify(await title()))
  // The header title renames the same way, and a single click there does nothing.
  const head = page.locator('.chat-header .chat-title')
  await head.click()
  if (await page.locator('.chat-header input.rename-input').count()) throw new Error('a single click on the header renames')
  await head.dblclick()
  const headField = page.locator('.chat-header input.rename-input')
  await headField.waitFor({ timeout: 2000 })
  if ((await headField.inputValue()) !== '文档核对') throw new Error('the header field holds ' + (await headField.inputValue()))
  await page.keyboard.press('Escape')
  await headField.waitFor({ state: 'detached', timeout: 2000 })
})

await check('the app chrome shows no I-beam, while the conversation and fields stay selectable', async () => {
  const look = (sel) => page.locator(sel).first().evaluate((el) => ({ cursor: getComputedStyle(el).cursor, select: getComputedStyle(el).userSelect }))
  for (const sel of ['.sidebar .nav-item.selected', '.sidebar .nav-item.selected .label', '.sidebar .section-head', '.chat-header .chat-title']) {
    const st = await look(sel)
    if (!['default', 'pointer'].includes(st.cursor) || st.select !== 'none') throw new Error(`${sel}: cursor ${st.cursor}, user-select ${st.select}`)
  }
  const row = page.locator('.sidebar .nav-item.selected')
  await row.hover()
  await row.locator('.trail .icon-btn').click()
  await page.waitForSelector('.menu .menu-item')
  const item = await look('.menu .menu-item')
  if (!['default', 'pointer'].includes(item.cursor) || item.select !== 'none') throw new Error(`menu item: cursor ${item.cursor}, user-select ${item.select}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.menu', { state: 'detached' })
  const text = await look('.transcript .md')
  if (!['auto', 'text'].includes(text.cursor) || text.select !== 'text') throw new Error(`transcript: cursor ${text.cursor}, user-select ${text.select}`)
  const box = await look('.composer textarea')
  if (box.cursor !== 'text') throw new Error('the composer shows ' + box.cursor)
  // The transcript's words can really be selected.
  await page.locator('.transcript .md').first().click({ clickCount: 3 })
  const picked = await page.evaluate(() => getSelection()?.toString() ?? '')
  if (!picked.trim()) throw new Error('nothing selected in the transcript')
  await page.evaluate(() => getSelection()?.removeAllRanges())
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
  const inProjects = await page.evaluate(async () => (await window.fenn.snapshot()).conversations.filter((c) => c.kind === 'chat' && c.projectId).length)
  if (inProjects) throw new Error(inProjects + ' chats inside projects')
})

await check('a project keeps a progress board of milestones and tasks, edited by hand', async () => {
  await page.click('.sidebar .recent-projects .nav-item:has-text("端到端")')
  // Threads are the milestones: the board only appears once something is on it (here, a goal the agent recorded).
  await page.click('.panel-head [data-more]')
  if (await page.locator('.menu .menu-item:has-text("里程碑")').count()) throw new Error('empty progress board offered')
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    const p = (await window.fenn.snapshot()).projects.find((x) => x.name.includes('端到端'))
    await window.fenn.updateProgress(p.id, { title: '第一版上线' })
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
  const p = await page.evaluate(async () => (await window.fenn.snapshot()).projects.find((x) => x.name.includes('端到端')))
  await page.evaluate((id) => window.fenn.addToLibrary(id, '', [{ name: '说明.md', data: btoa(unescape(encodeURIComponent('# 说明\n'))) }]), p.id)
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
    if (Math.abs(after - before) > 2) throw new Error(`the next card moved ${Math.round(after - before)}px`)
  }
  await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
})

await check('an answered card fades in its place, and a request that follows a while later rises into the same place', async () => {
  await page.click('.sidebar .nav-item:has-text("新建")')
  await page.locator('.composer-row .backend-chip').click()
  await page.locator('.menu .menu-item', { hasText: '演示 Agent' }).click()
  await page.fill('.composer textarea', '慢慢写三次')
  await page.keyboard.press('Enter')
  const top = async (sel) => (await page.locator(sel).boundingBox())?.y
  for (let k = 0; k < 3; k++) {
    await page.waitForSelector('.perm:not(.leaving)', { timeout: 5000 })
    const name = await page.locator('.perm:not(.leaving)').evaluate((e) => getComputedStyle(e).animationName)
    if (name !== 'rise-in') throw new Error(`card ${k + 1} comes in with "${name}"`)
    await page.waitForTimeout(300)
    const before = await top('.perm-slot')
    await page.click('.perm .btn.primary')
    if (k === 2) break
    // The agent runs the tool before it asks again: meanwhile the place stays where it was.
    await page.waitForSelector('.perm.leaving', { state: 'detached', timeout: 2000 })
    const held = await top('.perm-slot')
    if (held === undefined || Math.abs(held - before) > 2) throw new Error(`while waiting for the next request the place ${held === undefined ? 'closed' : `moved ${Math.round(held - before)}px`}`)
    await page.waitForSelector('.perm:not(.leaving)', { timeout: 5000 })
    const after = await top('.perm-slot')
    if (Math.abs(after - before) > 2) throw new Error(`card ${k + 2} landed ${Math.round(after - before)}px away`)
  }
  // Once the turn is over, the place closes.
  await page.waitForSelector('.perm-slot', { state: 'detached', timeout: 20000 })
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

await check('an agent puts a card on the home page from a chat; the card says where it came from and can be deleted', async () => {
  await page.fill('.composer textarea', '#看板 服务器待办')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.send-btn:not(.stop)', { timeout: 20000 })
  await page.click('.sidebar .nav-item:has-text("新建")')
  const card = page.locator('.widget.board-card:has-text("服务器待办")')
  await card.waitFor({ timeout: 5000 })
  if ((await card.locator('.board-list li').count()) !== 2) throw new Error('the list is not drawn')
  if (!(await card.locator('.board-source').count())) throw new Error('no source line')
  await card.hover()
  await card.locator('.widget-more').click()
  await page.click('.menu .menu-item:has-text("删除卡片")')
  await page.click('.modal.confirm .btn.danger-solid')
  await card.waitFor({ state: 'detached', timeout: 3000 })
})

await app.close()

// First launch: whatever the user types goes into the guide, never into the chat behind it.
{
  const dir = declareTestAgent(mkdtempSync(join(tmpdir(), 'oc-e2e-first-')))
  const launch = () => electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: dir } })
  let a = await launch()
  let p = await a.firstWindow()
  await p.evaluate(async () => { localStorage.setItem('oc-lang', 'zh'); await window.fenn.updateSettings({ language: 'zh' }) })
  await p.reload()
  await check('on first launch, typing a name and pressing Enter stays in the guide', async () => {
    await p.waitForSelector('.onboarding input')
    await p.waitForTimeout(500)
    if (!(await p.evaluate(() => document.activeElement?.matches('.onboarding input')))) throw new Error('focus is on ' + (await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))))
    await p.keyboard.type('小林')
    await p.keyboard.press('Enter')
    await p.waitForSelector('.onboarding h1:has-text("选择回答您的 AI")', { timeout: 3000 })
    const chats = await p.evaluate(async () => (await window.fenn.snapshot()).conversations.length)
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
  const app2 = await electron.launch({ args: ['.', '--no-sandbox'], env: { ...process.env, FENN_DATA_DIR: dir } })
  const p2 = await app2.firstWindow()
  await p2.evaluate(async () => { localStorage.setItem('oc-lang', 'zh'); await window.fenn.updateSettings({ language: 'zh' }) })
  await p2.reload()
  await p2.waitForSelector('.sidebar')
  if (await p2.locator('.onboarding').count()) await p2.click('.onboarding .skip')
  await check('a reply cut off by a restart says so and offers 重试', async () => {
    await p2.click('.sidebar .nav-item:has-text("被打断的对话")')
    const bar = p2.locator('.turn-note.interrupted')
    await bar.waitFor({ timeout: 5000 })
    if (!(await bar.innerText()).includes('因应用重启中断')) throw new Error('reads: ' + (await bar.innerText()))
    if (await p2.locator('.msg-error').count()) throw new Error('drawn as an error')
    await bar.locator('button:has-text("重试")').click()
    await p2.waitForSelector('.turn-note.interrupted', { state: 'detached', timeout: 8000 })
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
