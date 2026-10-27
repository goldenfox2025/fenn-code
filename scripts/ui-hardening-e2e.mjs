// Regression checks for defects found by the independent whole-UI audit. Isolated, hidden, no paid backends.
import {_electron as electron} from 'playwright-core';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {declareTestAgent} from './test-agent.mjs';import {resizeViewport} from './electron-ui.mjs';
const data=declareTestAgent(mkdtempSync(join(tmpdir(),'fenn-hardening-')));
const root=mkdtempSync(join(tmpdir(),'fenn-hardening-files-'));
writeFileSync(join(root,'preview.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7p0AAAAASUVORK5CYII=','base64'));
const state=JSON.parse(readFileSync(join(data,'state.json'),'utf8'));state.settings={...state.settings,onboarded:true,language:'zh',runInBackground:false,notifications:false};writeFileSync(join(data,'state.json'),JSON.stringify(state));
const app=await electron.launch({args:['.','--no-sandbox'],env:{...process.env,FENN_DATA_DIR:data,FENN_BACKGROUND_TEST:'1'}});
const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const shots=process.argv[2]||join(data,'shots');mkdirSync(shots,{recursive:true});
const nav=async label=>page.locator('.sidebar .nav > button').filter({has:page.locator('.label').filter({hasText:new RegExp('^'+label+'$')})}).click();
try{
 await page.locator('.sidebar').waitFor();await resizeViewport(page,{width:1440,height:900});
 assert.equal(await page.locator('.board-card').count(),0);console.log('PASS retired home widgets stay absent; inline chart accessibility is covered in e2e.mjs');
 await nav('定时任务');await page.getByRole('button',{name:'新建定时任务',exact:true}).click();
 await page.getByRole('textbox',{name:'名称',exact:true}).fill('Audit schedule');await page.getByRole('textbox',{name:'要做什么',exact:true}).fill('Do not run this fixture');
 await page.locator('.modal .dropdown').first().click();await page.locator('.menu').getByRole('menuitemradio',{name:'一次',exact:true}).click();
 await page.locator('input[type=datetime-local]').fill('');
 await page.getByRole('alert').filter({hasText:'请选择有效的时间'}).waitFor();assert(await page.locator('.modal-actions').getByRole('button',{name:'保存',exact:true}).isDisabled());assert.equal(await page.locator('.app-error').count(),0);
 await page.locator('.modal .dropdown').first().click();await page.locator('.menu').getByRole('menuitemradio',{name:'每天 / 每周',exact:true}).click();
 for(const b of await page.locator('.modal .day').all())await b.click();
 assert.equal(await page.locator('.modal .day[aria-pressed=true]').count(),0);assert(await page.locator('.modal-actions').getByRole('button',{name:'保存',exact:true}).isDisabled());
 await page.locator('.modal .day').first().click();assert(await page.locator('.modal-actions').getByRole('button',{name:'保存',exact:true}).isEnabled());
 await page.keyboard.press('Escape');console.log('PASS clearing dates and weekdays neither crashes nor schedules unexpected daily runs');
 await page.locator('.sidebar-foot').getByRole('button',{name:'设置',exact:true}).click();await page.locator('.settings-nav').getByRole('button',{name:'连接器',exact:true}).click();await page.getByRole('button',{name:'添加连接器',exact:true}).click();
 await page.locator('.settings-body').getByRole('textbox',{name:'名称',exact:true}).fill('Keep this draft');
 for(const exit of ['tab','close','backdrop','cancel','escape']){
  if(exit==='tab')await page.locator('.settings-nav').getByRole('button',{name:'通用',exact:true}).click();
  else if(exit==='close')await page.locator('.settings-close').click();
  else if(exit==='backdrop')await page.locator('.overlay').first().click({position:{x:5,y:5}});
  else if(exit==='cancel')await page.locator('.settings-body .modal-actions').getByRole('button',{name:'取消',exact:true}).click();
  else await page.keyboard.press('Escape');
  await page.locator('.modal.confirm').waitFor();await page.locator('.modal.confirm').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(await page.locator('.settings-body').getByRole('textbox',{name:'名称',exact:true}).inputValue(),'Keep this draft');
 }
 await page.locator('.settings-nav').getByRole('button',{name:'通用',exact:true}).click();await page.locator('.modal.confirm').getByRole('button',{name:'放弃',exact:true}).click();await page.locator('.settings-body h2').filter({hasText:'通用'}).waitFor();
 for(const [theme,width,height,zoom]of[['light',1440,900,1],['dark',1000,800,1.5],['light',760,650,1.25]]){
  await page.evaluate(theme=>window.fenn.updateSettings({theme}),theme);await resizeViewport(page,{width,height});await app.evaluate(({BrowserWindow},zoom)=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom),zoom);
  await page.locator('.settings-body .input').first().focus();await page.keyboard.press('Tab');
  const measured=await page.locator('.settings-modal').evaluate(el=>({overflow:el.scrollWidth>el.clientWidth+2,inside:el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth,focus:getComputedStyle(document.activeElement).outlineStyle}));
  assert(measured.inside&&!measured.overflow);
  const contrast = await page.evaluate(() => {
    const rgb = color => { const span=document.createElement('span');span.style.color=color;document.body.append(span);const out=getComputedStyle(span).color.match(/[\d.]+/g).slice(0,3).map(Number);span.remove();return out; };
    const luminance = c => rgb(c).map(x=>{const v=x/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const root=getComputedStyle(document.documentElement),bg=luminance(root.getPropertyValue('--bg-floating'));
    const values={};for(const token of ['--green','--amber','--text-3']){const fg=luminance(root.getPropertyValue(token));values[token]=(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)}return values;
  });
  for(const[token,ratio]of Object.entries(contrast))assert(ratio>=4.5,token+' contrast '+ratio);
  await page.screenshot({path:join(shots,'settings-'+theme+'-'+zoom+'.png')});
 }
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));await resizeViewport(page,{width:1440,height:900});await page.keyboard.press('Escape');
 const p=await page.evaluate(cwd=>window.fenn.createProject({name:'UI audit fixture',cwd,backendId:'mock'}),root);
 await page.evaluate(id=>window.fenn.saveMemory(id,{name:'keyboard-memory',description:'Open with the keyboard',type:'project',body:'## Verified memory content'}),p.id);
 await page.locator('.recent-projects .nav-item').filter({hasText:p.name}).click();
 const tab=async id=>{const b=page.locator('.panel-head [data-tab="'+id+'"]');if(await b.isVisible())await b.click();else{await page.locator('.panel-head [data-more]').click();await page.locator('.menu').getByRole('menuitemradio',{name:{memory:'项目记忆',files:'项目资料',library:'库'}[id],exact:true}).click()}};
 await tab('memory');const memory=page.locator('.memory-fact-toggle');await memory.focus();await memory.press('Enter');await page.locator('.memory-fact-body').filter({hasText:'Verified memory content'}).waitFor();assert.equal(await memory.getAttribute('aria-expanded'),'true');
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'编辑');console.log('PASS memory contents and edit actions are keyboard reachable');
 const materialRoot=join(data,'projects',p.id,'files');mkdirSync(join(data,'projects',p.id),{recursive:true});if(existsSync(materialRoot))rmdirSync(materialRoot);writeFileSync(materialRoot,'fixture: directory unavailable');
 await tab('library');await page.getByRole('button',{name:'添加的资料',exact:true}).click();await page.locator('.files-materials [role=alert]').filter({hasText:'无法读取资料'}).waitFor();
 rmSync(materialRoot);mkdirSync(materialRoot);writeFileSync(join(materialRoot,'reference.md'),'# Restored materials');await page.locator('.files-materials').getByRole('button',{name:'重试',exact:true}).click();await page.locator('.tree-row[data-path="/@materials/reference.md"]').waitFor();console.log('PASS project material failure is visible and retry recovers');
 await tab('library');await page.locator('.tree-row[data-path="preview.png"]').click();const full=page.locator('.files-preview button[data-focus-key="preview-full:preview.png"]');await full.focus();await full.press('Enter');await page.locator('.file-full').waitFor();assert(await page.locator('.file-full').evaluate(el=>el.contains(document.activeElement)));await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.dataset.focusKey),'preview-full:preview.png');console.log('PASS read-only fullscreen captures and restores keyboard focus');
 const input=page.locator('.workspace > .center > .workspace > .center .composer textarea');await input.fill('/');await page.locator('.slash-pop').waitFor();const active=await input.getAttribute('aria-activedescendant');assert(active&&await page.locator('[id="'+active+'"]').count());const options=await page.locator('.slash-pop [role=option]').count();await input.press('ArrowDown');if(options>1)assert.notEqual(await input.getAttribute('aria-activedescendant'),active);assert.equal(await page.locator('[id="'+await input.getAttribute('aria-activedescendant')+'"]').getAttribute('aria-selected'),'true');await input.press('Escape');assert.equal(await input.getAttribute('aria-expanded'),'false');await input.fill('');console.log('PASS composer popup exposes active keyboard selection');
 assert.deepEqual(errors,[]);console.log('HARDENING_PROFILE',data);
}catch(error){await page.screenshot({path:join(shots,'failure.png')});throw error}finally{await app.close()}
