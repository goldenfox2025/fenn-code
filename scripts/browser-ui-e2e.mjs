import { _electron as electron } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'
const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-browser-ui-')))
const agent = join(data, 'browser-agent.mjs')
writeFileSync(agent, readFileSync('resources/mock-agent.mjs','utf8').replace('    const text = userText(raw);', `
    if (raw.includes('#browser-ui ')) {
      const url=raw.match(/#browser-ui (https?:\\/\\/[^\\s<]+)/)?.[1];
      const result=await callTool(sessionId,s,'browser',{action:'open',url,mode:'isolated'});
      notify(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:result?.text||JSON.stringify(result)}});
      while(!abort.aborted)await new Promise(r=>setTimeout(r,50));
      return {stopReason:'cancelled'};
    }
    const text = userText(raw);`))
const config=JSON.parse(readFileSync(join(data,'backends.json'),'utf8'));config.find(b=>b.id==='mock').args=[agent];writeFileSync(join(data,'backends.json'),JSON.stringify(config))
const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'));state.settings={...state.settings,onboarded:true,language:'zh',theme:'light'};writeFileSync(join(data,'state.json'),JSON.stringify(state))
const server=createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><title>浏览器验收</title><style>body{font:20px system-ui;padding:40px;background:#f7f6f2;color:#222}button{padding:10px 20px}</style><h1>本地浏览器验收</h1><p>这个页面在后台打开。</p><button>查看内容</button>')});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const app=await electron.launch({args:['.'],env:{...process.env,FENN_DATA_DIR:data,FENN_BACKGROUND_TEST:'1'}})
const shots=resolve('.local/browser-ui-audit');mkdirSync(shots,{recursive:true})
try {
 const page=await app.firstWindow();page.setDefaultTimeout(10000);await page.locator('.sidebar').waitFor();await resizeViewport(page,{width:1440,height:900})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const conversation=await page.evaluate(url=>window.fenn.startChat({text:'#browser-ui '+url,backendId:'mock'}),`http://127.0.0.1:${server.address().port}/`)
 await page.locator('.sidebar .nav-item').filter({hasText:conversation.title}).click()
 await page.getByRole('button',{name:'本轮允许',exact:true}).click()
 const button=page.getByRole('button',{name:'浏览器画面',exact:true});await button.waitFor();await button.click()
 await page.locator('.browser-view img').waitFor()
 for(const [theme,width] of [['light',1440],['dark',680]]){
  await page.evaluate(theme=>window.fenn.updateSettings({theme}),theme);await resizeViewport(page,{width,height:900})
  await page.screenshot({path:join(shots,`${theme}-${width}.png`)})
  assert(await page.locator('.browser-view').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
 }
 await page.locator('.browser-view').getByRole('button',{name:'停止',exact:true}).click()
 await page.locator('.browser-view-caption').filter({hasText:'操作已结束'}).waitFor()
 assert.equal((await page.evaluate(id=>window.fenn.browserInfo(id),conversation.id)).active,false)
 await page.evaluate(id=>window.fenn.cancel(id),conversation.id)
 await page.getByRole('button',{name:'收起浏览器画面',exact:true}).click()
 await page.locator('.browser-panel').waitFor({state:'detached'})
 assert.deepEqual(errors,[])
 console.log('PASS Code ACP browser tools, scoped approval, in-app live view, stop, dark/narrow layout; no inference calls')
}catch(e){await (await app.firstWindow()).screenshot({path:join(shots,'failure.png')}).catch(()=>{});throw e}finally{await app.close();await new Promise(r=>server.close(r))}
