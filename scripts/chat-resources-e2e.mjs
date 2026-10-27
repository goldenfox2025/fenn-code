// Ordinary-chat resources and compact message index. Fixture data only, no model prompts.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const source=process.argv[2]; if(!source)throw Error('Pass isolated footer fixture')
assert(JSON.parse(readFileSync(join(source,'backends.json'),'utf8')).some(b=>['mock','fixture'].includes(b.id)))
const data=mkdtempSync(join(tmpdir(),'fenn-chat-resources-'))
for(const name of ['state.json','backends.json','messages','projects'])if(existsSync(join(source,name)))cpSync(join(source,name),join(data,name),{recursive:true})
const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'))
state.settings={...state.settings,theme:'light',language:'zh',onboarded:true};state.routines=[]
const conv=state.conversations.find(c=>c.title==='回复页脚 · 测试数据'),root=mkdtempSync(join(tmpdir(),'fenn-chat-files-'))
conv.cwd=root;writeFileSync(join(root,'note.txt'),'original');writeFileSync(join(root,'second.md'),'# Second')
const savedMessages=JSON.parse(readFileSync(join(data,'messages',conv.id+'.json'),'utf8'))
const finalReply=savedMessages.findLast(message=>message.role==='assistant');finalReply.blocks.find(block=>block.type==='text').text+='\n\n'+ '测量数据只使用当前后端实际报告的结果，缺失的数据不展示。'.repeat(8);writeFileSync(join(data,'messages',conv.id+'.json'),JSON.stringify(savedMessages))
const eligible=savedMessages.filter(m=>!m.hidden&&!m.housekeeping&&!m.action&&['user','assistant'].includes(m.role)&&!['streaming','error','cancelled'].includes(m.state))
const text=m=>m.blocks.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n')
const sourceNote=eligible.findLast(m=>m.role==='user'),outputNote=eligible.findLast(m=>m.role==='assistant')
delete conv.contextDigest
const selectedNotes=[{kind:'source',title:'未上报用量的情况',message_id:sourceNote.id,quote:text(sourceNote)},{kind:'output',title:'只展示实际测量的速度',message_id:outputNote.id,quote:text(outputNote).split('\n')[0]}]
const fixturePath=join(data,'digest-agent.mjs')
const agent=readFileSync('resources/mock-agent.mjs','utf8').replace('    const text = userText(raw);', `
    if(raw.startsWith('FENN_CONTEXT_DIGEST_V1')) {
      notify(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(JSON.stringify(selectedNotes))}}});
      return {stopReason:'end_turn'};
    }
    const text = userText(raw);`)
assert(agent.includes("raw.startsWith('FENN_CONTEXT_DIGEST_V1')"))
writeFileSync(fixturePath,agent)
const backends=JSON.parse(readFileSync(join(data,'backends.json'),'utf8'))
Object.assign(backends.find(backend=>backend.id===conv.backendId),{command:process.execPath,args:[fixturePath]})
writeFileSync(join(data,'backends.json'),JSON.stringify(backends))
writeFileSync(join(data,'state.json'),JSON.stringify(state))
const shots='.local/chat-resources-ui';mkdirSync(shots,{recursive:true})
const app=await electron.launch({args:['.'],env:{...process.env,FENN_DATA_DIR:data,FENN_BACKGROUND_TEST:'1'}})
try{
 const page=await app.firstWindow();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const settle=()=>page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished))})
 const shot=async name=>{await settle().catch(async error=>{if(!String(error).includes('Execution context was destroyed'))throw error;await page.locator('.greeting,.transcript').first().waitFor();await settle()});await page.screenshot({path:join(shots,name+'.png')})}
 const pane=page.locator('.side-pane'),library=page.locator('.chat-library.library-overview'),file=page.locator('.file-view')
 await page.locator('.sidebar').waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900))
 await shot('light-home-without-widgets');assert.equal(await page.locator('.widget,.widget-board,.heatmap').count(),0,'home has no widget UI')
 await page.locator('.sidebar .nav-item').filter({hasText:conv.title}).click()
 await page.locator('.conversation-nodes').waitFor()
 const geometry=await page.locator('.conversation-node').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().top))
 const messages=await page.locator('.transcript .msg-user').count()
 assert.equal(geometry.length,messages,'index includes user messages only')
 assert(geometry.length>=2&&geometry.slice(1).every((v,i)=>Math.abs(v-geometry[i]-10)<.2),'markers use a fixed 10px pitch')
 await page.locator('.conversation-node').last().hover();await page.locator('.node-preview').waitFor();await settle();assert(await page.evaluate(()=>{const nav=document.querySelector('.conversation-nodes'),marker=nav.querySelector('.conversation-node:hover').getBoundingClientRect(),preview=nav.querySelector('.node-preview').getBoundingClientRect();return Math.abs((marker.top+marker.bottom-preview.top-preview.bottom)/2)<2}),'preview centers on its hovered node');await shot('compact-index-preview')
 await page.locator('.conversation-node').last().focus();await page.keyboard.press('Escape')
 await page.locator('.side-pane-toggle').click();await pane.waitFor();await pane.locator('.context-note').first().waitFor()
 assert.equal(await pane.locator('.overview-empty').count(),0,'no oversized empty-state illustration')
 assert.equal(await pane.locator('.overview-section').count(),2,'only populated output/source sections are shown')
 assert.equal(await pane.locator('button svg.lucide-plus').count(),0,'the automatic digest is not a manual file creation form')
 assert((await pane.boundingBox()).height<420);assert((await pane.boundingBox()).width<=401)
 assert.equal(await pane.locator('.panel-head,.overflow-tabs').count(),0,'no embedded tab bar')
 assert(await pane.evaluate(el=>{const toolbar=el.querySelector('.context-toolbar'),card=el.querySelector('.context-floating-card');return !card.contains(toolbar)&&toolbar.getBoundingClientRect().bottom<card.getBoundingClientRect().top}),'toolbar is outside the independent floating card')
 await pane.getByRole('button',{name:'输出内容',exact:true}).click();assert.equal(await pane.getByRole('button',{name:'输出内容',exact:true}).getAttribute('aria-expanded'),'false');await pane.getByRole('button',{name:'输出内容',exact:true}).click()
 await pane.locator('.context-note').first().locator('summary').click();await shot('traceable-output-detail');await pane.getByRole('button',{name:'查看原消息',exact:true}).click();await pane.locator('.context-note').first().locator('summary').click()
 await pane.locator('[data-tab=threads]').click();assert.equal(await pane.locator('.context-thread-row').count(),0);await shot('chat-threads');await pane.locator('[data-tab=background]').click()
 await shot('light-reference-digest')
 await pane.locator('[data-tab="files"]').click();await library.waitFor()
 assert.equal(await library.locator('.files-head,.files-preview,.files-filter').count(),0,'ordinary chat uses the same compact index as projects')
 assert.equal(await pane.locator('.resize-handle').count(),0)
 await shot('light-chat-library')
 await library.locator('[data-path="note.txt"]').click();const editor=file.locator('.preview-editor');await editor.fill('edited chat file')
 await file.getByRole('button',{name:'关闭',exact:true}).click();await file.waitFor({state:'detached'});await library.waitFor()
 assert.equal(await page.evaluate(async id=>(await window.fenn.readLibraryFile(id,'note.txt')).text,conv.id),'edited chat file')
 await library.getByRole('button',{name:'添加至工作文件',exact:true}).click();await page.getByRole('menuitem',{name:'新建文件',exact:true}).click()
 await library.locator('.tree-input').fill('created.txt');await library.locator('.tree-input').press('Enter');await editor.fill('new ordinary chat file')
 await file.getByRole('button',{name:'关闭',exact:true}).click();await file.waitFor({state:'detached'});await library.waitFor()
 await library.locator('input[type=file]').setInputFiles({name:'uploaded.txt',mimeType:'text/plain',buffer:Buffer.from('uploaded')})
 await library.locator('[data-path="uploaded.txt"]').waitFor()
 await library.getByRole('button',{name:'工作文件',exact:true}).click();await pane.locator('.files-pane').waitFor()
 await pane.getByRole('button',{name:'筛选文件',exact:true}).click();const search=pane.getByPlaceholder('筛选文件');await search.fill('note')
 assert.equal(await search.evaluate(el=>getComputedStyle(el).boxShadow),'none','focus belongs to the outer search field only')
 assert.equal(await pane.locator('.tree-row[data-path]').count(),1)
 await shot('focused-file-search');await search.press('Escape')
 await pane.getByRole('button',{name:'返回库',exact:true}).click();await library.waitFor()
 for(const [theme,width]of[['dark',1440],['light',680]]){
  await page.evaluate(theme=>window.fenn.updateSettings({theme}),theme);await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),width)
  await shot(theme+'-'+width+'-library');assert.equal(await pane.evaluate(el=>el.scrollWidth>el.clientWidth+2),false)
  await pane.locator('[data-tab="background"]').click();await shot(theme+'-'+width+'-resources')
  await pane.locator('[data-tab="files"]').click();await library.waitFor()
 }
 assert.deepEqual(errors,[])
 console.log('PASS ordinary-chat resource sections, shared library/create/upload/edit/return, single search focus, fixed dense user-only index, themes/narrow. Profile:',data)
}catch(e){await(await app.firstWindow()).screenshot({path:join(shots,'failure.png')}).catch(()=>{});throw e}finally{await app.close()}
