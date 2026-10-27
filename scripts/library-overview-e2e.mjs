// Disposable resource-index acceptance. All ACP connections use fixture backends.
import { _electron as electron } from 'playwright-core'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { resizeViewport } from './electron-ui.mjs'
const source = process.argv[2]
if (!source) throw Error('Pass an isolated review fixture profile')
assert(JSON.parse(readFileSync(join(source, 'backends.json'), 'utf8')).some(b => ['mock', 'fixture'].includes(b.id)))
const data = mkdtempSync(join(tmpdir(), 'fenn-library-overview-'))
for (const name of ['state.json', 'backends.json', 'messages', 'projects']) if (existsSync(join(source, name))) cpSync(join(source, name), join(data, name), { recursive: true })
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
state.settings = { ...state.settings, theme: 'light', language: 'zh', onboarded: true }; state.routines = []
const project = state.projects[0], root = mkdtempSync(join(tmpdir(), 'fenn-library-content-'))
project.cwd = root
mkdirSync(join(root, 'folder')); writeFileSync(join(root, 'folder/child.txt'), 'child')
writeFileSync(join(root, 'notes.txt'), 'original'); writeFileSync(join(root, 'other.txt'), 'other')
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const shots = '.local/library-overview-ui'; mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
 const page = await app.firstWindow(); page.setDefaultTimeout(10000)
 const errors = []; page.on('pageerror', e => errors.push(e.message))
 const overview = page.locator('.library-overview'), browser = page.locator('.project-library.browsing'), file = page.locator('.file-view')
 const settle = () => page.evaluate(async () => { await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))) })
 const shot = async name => { await settle(); await page.screenshot({path:join(shots,name+'.png')}) }
 const saved = async (id,path,text) => page.waitForFunction(async ({id,path,text}) => (await window.fenn.readLibraryFile(id,path))?.text === text, {id,path,text})
 const closeFile = async () => { await file.getByRole('button',{name:'关闭',exact:true}).click(); await file.waitFor({state:'detached'}); await overview.waitFor() }
 const openLibrary = async () => { if (!await page.locator('.panel').isVisible()) await page.locator('[data-panel-toggle]').click(); if(await page.locator('.panel-head [data-tab="library"]').getAttribute('aria-selected')!=='true')await page.locator('.panel-head [data-tab="library"]').click(); await overview.waitFor() }
 await page.locator('.sidebar').waitFor(); await resizeViewport(page,{width:1440,height:900})
 await page.evaluate(() => localStorage.setItem('oc-width-panel','640'))
 await page.locator('.recent-projects .nav-item').filter({hasText:project.name}).click()
 assert.equal(await page.locator('.panel-welcome h2').count(),1,'master welcome anatomy restored')
 await openLibrary()
 assert((await page.locator('.project-context-card').boundingBox()).width<=401,'compact card ignores a workspace editor width')
 assert.equal(await page.locator('.project-context-card > .resize-handle').count(),0)
 assert.equal(await overview.locator('.library-source').count(),1,'empty attachment groups do not consume a section')
 assert.equal(await overview.locator('.files-preview,.files-split').count(),0,'overview has no empty editor frame')
 await shot('light-index')
 await overview.locator('[data-source="workspace"][data-path="notes.txt"]').click()
 const editor = file.locator('.preview-editor'); await editor.fill('edited')
 await editor.press('Control+s'); await saved(project.id,'notes.txt','edited')
 await editor.fill('pending draft'); writeFileSync(join(root,'notes.txt'),'external writer')
 await file.locator('.preview-conflict').waitFor()
 await file.getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await editor.inputValue(),'pending draft','held conflict cannot discard the draft')
 await file.getByRole('button',{name:'保留我的版本',exact:true}).click()
 await saved(project.id,'notes.txt','pending draft'); await closeFile()
 await overview.getByRole('button',{name:'添加至工作文件',exact:true}).click()
 await page.getByRole('menuitem',{name:'新建文件',exact:true}).click()
 await overview.locator('.tree-input').fill('created.txt'); await overview.locator('.tree-input').press('Enter')
 await editor.fill('new content'); await closeFile(); await saved(project.id,'created.txt','new content')
 await overview.locator('input[type="file"]').setInputFiles({name:'uploaded.md',mimeType:'text/markdown',buffer:Buffer.from('# Upload\n')})
 await overview.locator('[data-source="attachments"][data-path="uploaded.md"]').waitFor()
 await overview.locator('[data-source="attachments"][data-path="uploaded.md"]').click()
 await file.getByRole('radio',{name:'源码',exact:true}).check(); await editor.fill('# Edited upload\n')
 await closeFile(); await saved('project-files:'+project.id,'uploaded.md','# Edited upload\n')
 await overview.locator('[data-path="other.txt"]').click({button:'right'});await page.getByRole('menuitem',{name:'删除',exact:true}).click();await page.locator('.modal.confirm').getByRole('button',{name:'删除',exact:true}).click();await overview.locator('[data-path="other.txt"]').waitFor({state:'detached'});
 await overview.locator('[data-path="folder"]').click()
 await overview.locator('[data-path="folder/child.txt"]').waitFor()
 assert.equal(await page.locator('.project-library.browsing').count(),0,'folders expand directly in the compact library')
 await overview.locator('[data-path="folder/child.txt"]').click();await editor.fill('child edited');await closeFile();await saved(project.id,'folder/child.txt','child edited')
 await overview.locator('[data-path="folder/child.txt"]').focus();await page.keyboard.press('F2');await overview.locator('.tree-input').fill('renamed.txt');await page.keyboard.press('Enter');await overview.locator('[data-path="folder/renamed.txt"]').waitFor()
 await overview.getByRole('button',{name:'工作文件',exact:true}).click();await browser.waitFor()
 assert.equal(await browser.locator('.files-preview').count(),0,'browse reserves no blank preview before selection')
 await browser.getByRole('button',{name:'筛选文件',exact:true}).click()
 await browser.getByPlaceholder('筛选文件').fill('notes')
 assert.equal(await browser.locator('.tree-row[data-path]').count(),1)
 await browser.getByPlaceholder('筛选文件').press('Escape')
 assert.equal(await browser.locator('.files-filter').count(),0)
 await browser.getByRole('button',{name:'返回库',exact:true}).click(); await overview.waitFor()
 for(const [theme,width] of [['light',1440],['dark',900],['light',540]]) {
   await page.evaluate(theme=>window.fenn.updateSettings({theme}),theme); await resizeViewport(page,{width,height:900})
   if(width<850&&!await page.locator('.sidebar').evaluate(el=>el.classList.contains('closed'))) await page.locator('.sidebar button[data-tip^="收起侧栏"]').click()
   await settle(); if(!await overview.isVisible()) await openLibrary()
   await shot(`${theme}-${width}-index`)
   assert((await page.locator('.panel').boundingBox()).width<=401)
   assert.equal(await overview.evaluate(el=>el.scrollWidth>el.clientWidth+2),false)
   await overview.locator('[data-source="attachments"][data-path="uploaded.md"]').click()
   await editor.waitFor(); assert.equal(await editor.inputValue(),'# Edited upload\n')
   await shot(`${theme}-${width}-editor`); await closeFile()
 }
 await resizeViewport(page,{width:1440,height:900});await settle()
 const closing = await page.evaluate(async()=>{
   const pane=document.querySelector('.panel'), main=pane.parentElement.querySelector(':scope > .center'), widths=[main.getBoundingClientRect().width]
   const before={paneClass:pane.className,position:getComputedStyle(pane).position,paneWidth:pane.getBoundingClientRect().width,viewport:innerWidth}
   document.querySelector('.panel .panel-head button[aria-label="关闭"]').click()
   for(let i=0;i<24;i++){await new Promise(r=>requestAnimationFrame(r));widths.push(main.getBoundingClientRect().width)}
   const delta=widths.at(-1)-widths[0],maxStep=Math.max(...widths.slice(1).map((v,i)=>Math.abs(v-widths[i])))
   return {before,delta,maxStep,intermediate:widths.some(v=>v>widths[0]+5&&v<widths.at(-1)-5)}
 })
 assert(closing.delta>100&&closing.intermediate&&closing.maxStep<closing.delta*.55,'fixed compact card releases layout continuously: '+JSON.stringify(closing))
 await openLibrary();await page.locator('.panel-head [data-tab=library]').click();await page.locator('.panel').waitFor({state:'detached'});assert.equal(await page.locator('.panel-head').count(),0,'closing the active icon removes the complete card and toolbar');
 await page.locator('[data-panel-toggle]').click();await overview.waitFor();assert.equal(await page.locator('.panel-head [data-tab=library]').getAttribute('aria-selected'),'true','reopening retains the last destination');
 assert.deepEqual(errors,[])
 console.log('PASS master thread welcome, fixed compact card, direct source sections, create/upload/open/edit/save/conflict retention, folder expansion/filter/Back, light/dark/narrow.')
 console.log('LIBRARY_OVERVIEW_PROFILE',data)
} catch(e) { await(await app.firstWindow()).screenshot({path:join(shots,'failure.png')}).catch(()=>{});throw e } finally {await app.close()}
