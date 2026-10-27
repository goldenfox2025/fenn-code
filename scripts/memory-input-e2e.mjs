// Both products exercise the same checked-in editor. Deterministic local ACP only.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { resizeViewport } from './electron-ui.mjs'
const bot=process.argv.includes('--bot'), fixture=process.argv[2]
const root=bot?resolve(process.env.FENN_BOT_ROOT??'../fenn-bot'):process.cwd()
const data=mkdtempSync(join(tmpdir(),'fenn-memory-ui-'))
for(const name of ['state.json','backends.json','projects','bots','messages'])if(existsSync(join(fixture,name)))cpSync(join(fixture,name),join(data,name),{recursive:true})
const agent=join(data,'agent.mjs')
writeFileSync(agent,readFileSync('resources/mock-agent.mjs','utf8').replace("if (raw.includes('[FENN_MEMORY_DRAFT_V1]')) {",`if (raw.includes('[FENN_MEMORY_DRAFT_V1]')) {
      await new Promise(r=>setTimeout(r,1500));
      if(raw.includes('#invalid-memory')){await stream(sessionId,'Invalid output',abort);return {stopReason:'end_turn'};}`))
const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'))
const scope=bot?state.bots[0].id:state.projects.find(p=>p.name==='并行验收试验 · 测试数据').id
const backend=bot?state.bots[0].backendId:'mock'
writeFileSync(join(data,'backends.json'),JSON.stringify([{id:backend,name:'Fixture ACP',command:process.execPath,args:[agent]}]))
if(bot){state.config.theme='light';state.config.browserMode='isolated'}else state.settings={...state.settings,theme:'light',language:'zh',onboarded:true}
writeFileSync(join(data,'state.json'),JSON.stringify(state))
const app=await electron.launch({args:[root],cwd:root,env:{...process.env,...(bot?{FENN_BOT_DATA:data,FENN_BOT_BACKGROUND:'1',FENN_BOT_TEST:'1'}:{FENN_DATA_DIR:data,FENN_BACKGROUND_TEST:'1'})}})
const shots=resolve('.local/memory-ui-audit',bot?'bot':'code');mkdirSync(shots,{recursive:true})
try {
 const page=await app.firstWindow();page.setDefaultTimeout(10000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const snapshot=()=>page.evaluate(bot=>bot?window.bot.snapshot():window.fenn.snapshot(),bot)
 const entries=()=>page.evaluate(({bot,scope})=>bot?window.bot.listMemory(scope):window.fenn.listMemory(scope),{bot,scope})
 const tab=async label=>{if(bot)await page.getByRole('radio',{name:label,exact:true}).check();else{const direct=page.getByRole('tab',{name:label,exact:true});if(await direct.isVisible())await direct.click();else{await page.locator('.panel-head [data-more]').click();await page.getByRole('menuitemradio',{name:label,exact:true}).click()}}}
 if(bot){await page.locator('.bot-app').waitFor();await page.getByRole('button',{name:'查看 Bot 详情',exact:true}).click()}else{await page.locator('.sidebar').waitFor();await resizeViewport(page,{width:1440,height:900});await page.locator('.recent-projects .nav-item').filter({hasText:'并行验收试验 · 测试数据'}).click()}
 await tab(bot?'记忆':'项目记忆')
 const before=await snapshot(), count=bot?before.bots[0].messages.length:before.conversations.length
 // Start from an empty memory collection in this copied fixture only.
 for(const entry of await entries())await page.evaluate(({bot,scope,name})=>bot?window.bot.deleteMemory(scope,name):window.fenn.deleteMemory(scope,name),{bot,scope,name:entry.name})
 await page.getByRole('button',{name:'添加记忆',exact:true}).click()
 const input=page.getByRole('textbox',{name:'记忆内容',exact:true})
 await input.fill('先给结论，保留不确定性。 @ui-craft')
 await page.getByRole('option').filter({hasText:'ui-craft'}).click()
 await page.locator('.memory-input-form input[type=file]').setInputFiles({name:'reference.md',mimeType:'text/markdown',buffer:Buffer.from('附件事实：始终核对实际画面。')})
 await page.waitForFunction(()=>document.querySelectorAll('.memory-reference-chips > span').length===2)
 await page.screenshot({path:join(shots,'references.png')})
 await page.getByRole('button',{name:'整理记忆',exact:true}).click()
 await tab(bot?'详情':'讨论串');await tab(bot?'记忆':'项目记忆')
 await page.getByRole('button',{name:'保存记忆',exact:true}).waitFor()
 assert((await input.inputValue()).includes('附件事实'))
 assert.equal((await entries()).length,0,'No storage before explicit review')
 await page.screenshot({path:join(shots,'review.png')})
 await page.getByRole('button',{name:'保存记忆',exact:true}).click()
 await page.locator('.memory-fact-toggle').waitFor()
 assert.equal((await entries()).length,1)
 assert((await entries())[0].body.includes('附件事实'))
 await page.getByRole('button',{name:'添加记忆',exact:true}).click();await input.fill('#invalid-memory 请保留原输入。')
 await page.getByRole('button',{name:'整理记忆',exact:true}).click();await page.locator('.memory-error').filter({hasText:'未返回'}).waitFor()
 assert.equal(await input.inputValue(),'#invalid-memory 请保留原输入。')
 assert.equal((await entries()).length,1)
 const after=await snapshot();assert.equal(bot?after.bots[0].messages.length:after.conversations.length,count,'Housekeeping creates no user chat/history')
 assert.deepEqual(errors,[])
 console.log(`PASS ${bot?'Bot':'Code'} one-input memory, @skill, file, background tab survival, explicit save, malformed result preservation, no history pollution`)
}catch(e){await (await app.firstWindow()).screenshot({path:join(shots,'failure.png')}).catch(()=>{});throw e}finally{await app.close()}
