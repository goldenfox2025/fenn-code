// Hidden Electron acceptance, isolated fixture state; no provider prompts.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-background-ui-')))
const cwd = mkdtempSync(join(tmpdir(), 'fenn-background-files-'))
const shots = resolve('.local/background-ui'), now = Date.now()
mkdirSync(shots, { recursive: true });writeFileSync(join(cwd, 'README.md'), '# Working folder')
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0 }
const conversation = (id, title, extra = {}) => ({ id, title, kind: 'chat', backendId: 'mock', cwd, status: 'idle', createdAt: now, updatedAt: now, ...extra })
state.conversations = [conversation('root', '后台任务验收'), conversation('child', '检查键盘与窄窗口', { parentId: 'root', status: 'done' })]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await app.firstWindow({ timeout: 15000 }), errors = []
  page.setDefaultTimeout(8000);page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor();await resizeViewport(page, { width: 1360, height: 850 })
  await page.locator('.sidebar .nav-item').filter({ hasText: '后台任务验收' }).click()
  await page.locator('.side-pane-toggle').click();await page.locator('.side-pane [data-tab=background]').click()
  const pane = page.locator('.background-panel'), side = page.locator('.side-pane')
  const patch = (id, value) => page.evaluate(({id,value}) => window.fenn.updateConversation(id, value), { id, value })
  const settle = () => page.evaluate(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)) })
  const shot = async name => { await page.mouse.move(10,840);await settle();await side.screenshot({path:join(shots,name+'.png')}) }
  const log = Array.from({ length: 130 }, (_, i) => `输出 ${i + 1}：核对任务的实际状态。`).join('\n')
  const running = Array.from({ length: 6 }, (_, i) => ({id:`run-${i}`,command:`node check-${i}.mjs`,title:['保持本地预览服务','核对文件修改','检查键盘与窄窗口布局的长标题不会挤走操作和状态','验证自动保存','复查任务数据','构建应用'][i],startedAt:now-i*60000,managed:i===0,output:log}))
  const ended = [{id:'failed',command:'npm run check',title:'检查依赖',startedAt:now-300000,endedAt:now-100000,failed:true,output:'无法连接到依赖服务。'}, {id:'done',command:'npm run typecheck',title:'类型检查',startedAt:now-400000,endedAt:now-200000,exitCode:0,output:'检查通过。'}]
  await patch('root', { background: [...running, ...ended] })
  await page.waitForFunction(() => document.querySelector('.side-pane .tab-count')?.textContent === '6')
  assert.equal(await pane.locator('.background-task:visible').count(), 4)
  assert.equal(await pane.locator('.background-task').filter({hasText:'保持本地预览服务'}).locator('.background-stop').count(),0,'Backend-owned tasks cannot expose unsupported stop controls')
  assert.equal(await pane.locator('.background-failures').innerText(),'1 项失败')
  assert(await side.evaluate(el => el.getBoundingClientRect().height < 450), 'Task summary is content-sized')
  await pane.locator('.background-more').focus();await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.background-task').length === 6)
  await page.keyboard.press('Enter')
  assert(await pane.locator('.steps-fold').evaluate(el=>el.inert),'Closing rows become inert immediately')
  await pane.locator('.steps-fold').waitFor({state:'detached'})
  await pane.locator('.background-task-open').filter({hasText:'保持本地预览服务'}).click()
  await pane.locator('.background-output').waitFor()
  const output = pane.locator('.background-output')
  assert(await output.evaluate(el=>el.scrollTop>0),'Initial log follows its tail')
  await output.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))})
  await pane.locator('.background-follow').waitFor()
  running[0].output = log+'\nnew-tail'
  await patch('root',{background:[...running,...ended]})
  await page.waitForFunction(()=>document.querySelector('.background-output')?.textContent.includes('new-tail'))
  assert.equal(await output.evaluate(el=>el.scrollTop),0,'New output preserves the reader’s earlier position')
  await pane.locator('.background-follow').click()
  assert(await output.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<8))
  await page.getByRole('button',{name:'返回任务列表',exact:true}).click()
  assert(await pane.locator('.background-task-open').filter({hasText:'保持本地预览服务'}).evaluate(el=>el===document.activeElement),'Returning restores keyboard focus')
  await pane.locator('.background-history').click()
  assert.equal(await pane.locator('.background-task').count(),3)
  await pane.locator('.background-task-open').filter({hasText:'检查依赖'}).click()
  assert.equal(await pane.locator('.background-detail-meta > span').first().innerText(),'失败','Failure without exit code stays a failure')
  await shot('failure-detail')
  await page.getByRole('button',{name:'返回任务列表',exact:true}).click()
  await page.getByRole('button',{name:'返回后台任务',exact:true}).click()
  // Completion must update both the badge and the history without remounting
  // or pretending an unknown end is a successful one.
  running[0].endedAt=Date.now()
  await patch('root',{background:[...running,...ended]})
  await page.waitForFunction(()=>document.querySelector('.side-pane .tab-count')?.textContent==='5')
  await pane.locator('.background-history').click()
  assert.equal(await pane.locator('.background-task').filter({hasText:'保持本地预览服务'}).locator('.background-task-meta').innerText(),'已结束')
  await page.getByRole('button',{name:'返回后台任务',exact:true}).click()
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>window.fenn.updateSettings({theme}),theme)
    for(const width of [1360,860,640]) {
      await resizeViewport(page,{width,height:850});await settle()
      const rows=await pane.locator('.background-task:visible').evaluateAll(rows=>rows.map(el=>{const title=el.querySelector('.background-task-title').getBoundingClientRect(),meta=el.querySelector('.background-task-meta').getBoundingClientRect();return{overflow:el.scrollWidth-el.clientWidth,titleHeight:title.height,gap:meta.left-title.right}}))
      assert(rows.every(row=>row.overflow<=1&&row.titleHeight<22&&row.gap>=0),JSON.stringify(rows))
      assert(await side.evaluate(el=>{const r=el.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight&&r.top>=0}))
      await shot(`${theme}-${width}`)
    }
  }
  await resizeViewport(page,{width:1360,height:850})
  // Scope follows the child without confusing equal provider command IDs.
  await patch('child',{status:'working',background:[{...running[1],title:'子对话中的命令',output:'child-session-output'}]})
  await pane.locator('.background-task-open').filter({hasText:'检查键盘与窄窗口'}).first().click()
  await page.waitForFunction(()=>document.querySelector('.chat-title')?.textContent==='检查键盘与窄窗口')
  await page.waitForFunction(()=>document.querySelector('.side-pane .tab-count')?.textContent==='7')
  if(await pane.locator('.background-more').count())await pane.locator('.background-more').click()
  await pane.locator('.background-task-open').filter({hasText:'子对话中的命令'}).click()
  await pane.locator('.background-output').filter({hasText:'child-session-output'}).waitFor()
  await page.getByRole('button',{name:'返回任务列表',exact:true}).click()
  await pane.locator('.background-task-open').filter({hasText:'核对文件修改'}).click()
  await pane.locator('.background-output').filter({hasText:'输出 130'}).waitFor()
  assert(!(await pane.locator('.background-output').innerText()).includes('child-session-output'))
  await patch('child',{status:'idle',background:[]})
  await page.locator('.sidebar .nav-item').filter({hasText:'后台任务验收'}).click()
  await patch('root',{background:Array.from({length:40},(_,i)=>({...running[1],id:`many-${i}`,title:`并行任务 ${i+1}`}))})
  await pane.locator('.background-more').click();await settle()
  assert.equal(await pane.locator('.background-task:visible').count(),40)
  assert(await pane.evaluate(el=>el.scrollHeight>el.clientHeight),'Expanded long lists scroll within the panel')
  assert(await side.evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight),'A long task list stays inside the window')
  await patch('root',{background:[]})
  await page.evaluate(()=>window.fenn.deleteConversation('child'))
  await pane.getByText('没有后台任务',{exact:true}).waitFor()
  await shot('empty')
  assert.equal(await side.locator('.tab-count').count(),0)
  await side.locator('[data-tab=files]').click()
  await page.locator('.tree-row[data-path="README.md"]').waitFor()
  assert(await side.evaluate(el=>el.getBoundingClientRect().height>600),'Files retain the full workspace pane')
  assert.deepEqual(errors,[])
  assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())))
  console.log('PASS background: compact active/history/detail views, four-row disclosure, keyboard, owner scope, running count, failures, completion, log following, light/dark at 1360/860/640, empty state and unchanged files.');console.log(shots)
} finally { await app.close() }
