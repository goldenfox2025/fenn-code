// Reuse a completed isolated review fixture. Never sends a model prompt.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { resizeViewport } from './electron-ui.mjs'
const fixture = process.argv[2]
if (!fixture || !existsSync(join(fixture, 'state.json'))) throw Error('Pass a completed review fixture directory.')
const data = mkdtempSync(join(tmpdir(), 'fenn-thread-navigation-'))
for (const file of ['state.json', 'backends.json', 'messages', 'projects']) if (existsSync(join(fixture,file))) cpSync(join(fixture,file),join(data,file),{recursive:true})
const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'))
state.settings={...state.settings,onboarded:true,language:'zh',theme:'light',runInBackground:false}
writeFileSync(join(data,'state.json'),JSON.stringify(state))
const project=state.projects.find(p=>p.name==='并行验收试验 · 测试数据')
const app=await electron.launch({args:['.'],env:{...process.env,FENN_DATA_DIR:data,FENN_BACKGROUND_TEST:'1'}})
try {
  const page=await app.firstWindow();page.setDefaultTimeout(8000)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.locator('.sidebar').waitFor()
  await resizeViewport(page,{width:1440,height:900})
  await page.locator('.recent-projects .nav-item').filter({hasText:project.name}).click()
  const card=page.locator('.center .thread-card').filter({hasText:'独立改动 A'})
  await card.waitFor()
  for(const width of [1440,680]) {
    await resizeViewport(page,{width,height:900})
    if(await page.locator('.sidebar').isVisible() && !await page.locator('.sidebar').evaluate(el=>el.classList.contains('closed')) && width<850) await page.locator('.sidebar button[data-tip^="收起侧栏"]').click()
    for(let attempt=0;attempt<3;attempt++) {
      if(await page.locator('.panel').isVisible()) {
        if(await page.locator('.thread-view').count()) await page.locator('.thread-view .panel-head button[data-tip="关闭讨论串"]').click()
        else await page.locator('.panel-head button[aria-label="关闭"]').click()
      }
      await card.click()
      await page.locator('.thread-view').waitFor({state:'visible'})
      assert.match(await page.locator('.thread-view .panel-head').innerText(),/独立改动 A/)
    }
  }
  assert.deepEqual(errors,[])
  console.log('PASS main-chat thread cards reopen closed panels, including repeated same-route navigation at wide/narrow widths.')
} finally {await app.close()}
