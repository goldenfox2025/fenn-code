// Real file APIs and hidden windows; no model requests or normal-profile data.
import { _electron as electron } from 'playwright-core'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-files-')))
const root = join(mkdtempSync(join(tmpdir(), 'fenn-files-work-')), 'Fenn 示例项目')
const singleRoot = mkdtempSync(join(tmpdir(), 'fenn-single-file-'))
writeFileSync(join(singleRoot, '测试文件.txt'), '用于检查只有一个文件时的列表、筛选与返回。')
const shots = resolve(process.argv[2] ?? '.local/files-navigation')
mkdirSync(root); mkdirSync(shots, { recursive: true })
for (const dir of ['docs', 'src/components', 'archive']) mkdirSync(join(root, dir), { recursive: true })
const readme = '# 文件与项目资料\n\n工作目录与参考资料在同一个库中浏览。\n\n## 本次改进\n\n- 返回列表，保持原来的阅读位置\n- 文件可直接编辑，修改自动保存\n- 上传资料独立存放，便于项目内共享\n\n## 验收\n\n检查窄栏、宽栏、深色模式与保存冲突。'
for (const [path, text] of Object.entries({ 'README.md': readme, 'docs/设计记录.md': '# 设计记录\n\n沿用现有颜色与控件。', 'docs/验收清单.md': '# 验收清单\n\n- [ ] 返回位置\n- [ ] 上传与编辑', 'src/components/Library.tsx': 'export function Library() {\n  return <section aria-label="项目文件" />\n}', 'src/app.tsx': '// Application entry', 'package.json': '{\n  "name": "fenn-preview",\n  "private": true\n}' })) writeFileSync(join(root, path), text)
for (let i = 0; i < 65; i++) writeFileSync(join(root, 'archive', `${String(i).padStart(2, '0')}-记录.txt`), `记录 ${i}`)
const materials = join(data, 'projects', 'project', 'files')
mkdirSync(materials, { recursive: true })
writeFileSync(join(materials, 'README.md'), '# 项目参考\n\n这份资料独立于工作目录的同名文件。')
writeFileSync(join(materials, '需求说明.md'), '# 需求说明\n\n保持文件管理轻巧、直接。')
const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8')), now = Date.now()
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'light', dotGrid: 0 }
state.projects = [{ id: 'project', name: '文件整理 · 示例', cwd: root, backendId: 'mock', conversationId: 'main', createdAt: now, updatedAt: now }, { id: 'empty', name: '无工作目录 · 示例', backendId: 'mock', conversationId: 'empty-main', createdAt: now, updatedAt: now }]
state.conversations = state.projects.map(p => ({ id: p.conversationId, title: p.name, kind: 'project', projectId: p.id, backendId: 'mock', cwd: p.cwd, status: 'idle', createdAt: now, updatedAt: now }))
state.conversations.push({ id: 'single', title: '单文件对话 · 示例', kind: 'chat', backendId: 'mock', cwd: singleRoot, status: 'idle', createdAt: now, updatedAt: now })
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
mkdirSync(join(data, 'messages'))
writeFileSync(join(data, 'messages', 'main.json'), JSON.stringify([
  { id: 'u', conversationId: 'main', role: 'user', createdAt: now, blocks: [{ type: 'text', text: '把文件与项目资料整理得更方便使用。' }] },
  { id: 'a', conversationId: 'main', role: 'assistant', state: 'done', createdAt: now + 1, blocks: [{ type: 'text', text: '这是编译后界面的隔离示例，用于检查文件浏览、编辑与布局。' }, { type: 'tool', id: 'write', title: '更新设计记录', toolKind: 'edit', status: 'completed', paths: [join(root, 'docs', '设计记录.md'), join(root, 'README.md')] }] }
]))
writeFileSync(join(data, 'messages', 'single.json'), JSON.stringify([
  { id: 'single-u', conversationId: 'single', role: 'user', createdAt: now, blocks: [{ type: 'text', text: '新建一个测试文件。' }] },
  { id: 'single-a', conversationId: 'single', role: 'assistant', createdAt: now + 1, state: 'done', blocks: [{ type: 'tool', toolId: 'single-write', title: '写入测试文件', toolKind: 'edit', status: 'completed', paths: [join(singleRoot, '测试文件.txt')] }] }
]))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
const checks = []
try {
  const page = await app.firstWindow({ timeout: 15000 }); page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', error => errors.push(String(error)))
  await page.locator('.sidebar').waitFor(); await resizeViewport(page, { width: 1360, height: 850 })
  const pane = page.locator('.panel .files-pane')
  const row = path => pane.locator(`.tree-row[data-path="${path}"]`)
  const back = async () => { const button = pane.getByRole('button', { name: '返回文件列表', exact: true }); if (await button.isVisible()) await button.click() }
  const shot = async (name, selector = '.panel') => { await page.mouse.move(600, 30); await page.evaluate(() => Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))); await page.locator(selector).screenshot({ path: join(shots, name + '.png') }) }
  await page.locator('.recent-projects .nav-item').filter({ hasText: '文件整理 · 示例' }).click()
  await page.locator('.panel-head [data-tab=library]').click()
  await row('docs').click(); await row('src').click()
  await pane.getByRole('button', { name: '添加的资料', exact: true }).click()
  await row('/@materials/需求说明.md').waitFor()
  await shot('library')
  checks.push('working files and collapsible materials share one tree')

  await row('archive').click()
  const target = row('archive/52-记录.txt'); await target.scrollIntoViewIfNeeded()
  const scrollBefore = await pane.locator('.files-rows').evaluate(el => el.scrollTop)
  assert(scrollBefore > 0)
  await target.click(); await pane.locator('.preview-editor').waitFor(); await back()
  assert.equal(await pane.locator('.files-rows').evaluate(el => el.scrollTop), scrollBefore)
  assert(await target.evaluate(el => el === document.activeElement && el.classList.contains('active')))
  assert.equal(await row('archive').getAttribute('aria-expanded'), 'true')
  await row('archive').click()
  checks.push('narrow return retains scroll, selected row, expansion and keyboard focus')

  await row('/@materials/README.md').click()
  await pane.locator('.preview-head').getByRole('radio', { name: '源码', exact: true }).check()
  const edit = pane.locator('.preview-editor')
  await edit.fill('# 项目参考\n\n已补充资料。')
  await pane.locator('.preview-save-state').filter({ hasText: '已保存' }).waitFor()
  assert.equal(readFileSync(join(materials, 'README.md'), 'utf8'), '# 项目参考\n\n已补充资料。')
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), readme)
  assert.equal(await pane.locator('.preview-meta').innerText(), '添加的资料')
  await edit.fill('# 我正在编辑')
  writeFileSync(join(materials, 'README.md'), '# 来自外部的改动')
  await pane.locator('.preview-conflict').waitFor()
  await pane.getByRole('button', { name: '返回文件列表', exact: true }).click()
  assert(await edit.isVisible())
  assert.equal(await edit.inputValue(), '# 我正在编辑')
  await pane.getByRole('button', { name: '用现在的文件', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.files-pane .preview-editor')?.value === '# 来自外部的改动')
  await back()
  await row('/@materials/README.md').focus(); await page.keyboard.press('F2')
  await pane.locator('.tree-input').fill('参考说明.md'); await page.keyboard.press('Enter')
  await row('/@materials/参考说明.md').waitFor()
  assert(existsSync(join(materials, '参考说明.md')))
  assert(existsSync(join(root, 'README.md')))
  checks.push('materials autosave, conflict protection and rename stay in the correct root')

  await pane.getByRole('button', { name: '新建或添加文件', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: '添加资料…', exact: true }).click()
  await (await chooser).setFiles({ name: '新增参考.txt', mimeType: 'text/plain', buffer: Buffer.from('上传成功') })
  await row('/@materials/新增参考.txt').waitFor()
  assert(!existsSync(join(root, '新增参考.txt')))
  checks.push('upload lands in project materials and opens its group')

  const geometry = file => file.evaluate(el => {
    const box = el.getBoundingClientRect()
    const x = node => Math.round((node.getBoundingClientRect().left - box.left) * 100) / 100
    const more = el.parentElement.querySelector('.tree-more')
    return { height: box.height, icon: x(el.querySelector('svg:not(.tree-caret)')), name: x(el.querySelector('.tree-name')), mark: x(el.querySelector('.tree-mark')), more: x(more), font: getComputedStyle(el).fontSize }
  })
  const menuLabels = async () => {
    await row('README.md').click({ button: 'right' })
    const labels = await page.locator('.menu [role=menuitem]').allTextContents()
    await page.keyboard.press('Escape')
    return labels
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
    const filesGeometry = await geometry(row('README.md'))
    const fileActions = await menuLabels()
    await shot(`consistent-${theme}-files`)
    await pane.locator('.files-view-tabs').getByRole('radio', { name: /^更改/ }).check()
    assert.deepEqual(await geometry(row('README.md')), filesGeometry)
    assert.deepEqual(await menuLabels(), fileActions)
    await row('README.md').focus(); await page.keyboard.press('F2')
    await pane.locator('.tree-input').waitFor(); await page.keyboard.press('Escape')
    await shot(`consistent-${theme}-changes`)
    await pane.locator('.files-view-tabs').getByRole('radio', { name: '文件', exact: true }).check()
  }
  await page.evaluate(() => window.fenn.updateSettings({ theme: 'light' }))
  checks.push('Files and Changes share identical row geometry, state markers, context actions and keyboard rename in both themes')

  await pane.locator('.files-view-tabs').getByRole('radio', { name: /^更改/ }).check()
  await row('docs/设计记录.md').click(); await edit.waitFor(); await back()
  assert(await row('docs/设计记录.md').evaluate(el => el.classList.contains('active')))
  await pane.locator('.files-view-tabs').getByRole('radio', { name: '文件', exact: true }).check()
  await row('README.md').click()
  await pane.locator('.preview-head').getByRole('radio', { name: '预览', exact: true }).check()
  await pane.locator('.preview-md h1').waitFor()
  assert(!/ B| KB/.test(await pane.locator('.preview-head').innerText()))
  await shot('preview')
  await shot('whole-window', 'body')
  await page.locator('.panel .panel-head').getByRole('button', { name: '全屏', exact: true }).click()
  await pane.locator('.files-tree').waitFor({ state: 'visible' })
  await shot('wide-library')
  checks.push('change list opens full content; wide layout keeps tree and preview together')

  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
    for (const width of [1360, 860, 640]) {
      await resizeViewport(page, { width, height: 850 })
      const overflow = await pane.locator('.preview-head').evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth, title: el.querySelector('.preview-name')?.clientWidth }))
      assert(overflow.content <= overflow.width + 1, JSON.stringify({ theme, width, ...overflow }))
      assert(overflow.title > 45, JSON.stringify({ theme, width, ...overflow }))
      if (width === 640) await shot(`${theme}-narrow`)
    }
  }
  checks.push('both themes at 1360, 860 and 640 px retain readable headers without overflow')
  await page.keyboard.press('Escape')
  await pane.locator('.preview-name').waitFor()
  assert.equal(await pane.locator('.preview-name').innerText(), 'README.md')
  checks.push('resizing and leaving full screen retain the open file')
  await resizeViewport(page, { width: 1360, height: 850 })
  await page.locator('.recent-projects .nav-item').filter({ hasText: '无工作目录 · 示例' }).click()
  await page.locator('.panel-head [data-tab=library]').click()
  assert.equal(await pane.locator('.files-materials').count(), 0)
  await pane.getByRole('button', { name: '新建或添加文件', exact: true }).click()
  const emptyChooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: '添加资料…', exact: true }).click()
  await (await emptyChooser).setFiles({ name: '项目说明.txt', mimeType: 'text/plain', buffer: Buffer.from('没有工作目录也可以添加项目资料。') })
  await row('/@materials/项目说明.txt').click(); await edit.waitFor()
  assert.equal(await edit.inputValue(), '没有工作目录也可以添加项目资料。')
  checks.push('empty material group stays hidden; a project without a working folder can add and read materials')
  await page.locator('.sidebar .nav-item').filter({ hasText: '单文件对话 · 示例' }).click()
  await page.locator('.side-pane-toggle').click()
  const singlePane = page.locator('.side-pane .files-pane')
  const singleFile = singlePane.locator('.tree-row[data-path="测试文件.txt"]')
  await singleFile.waitFor()
  await singlePane.getByRole('button', { name: '新建或添加文件', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const newFile = singlePane.locator('.tree-row.renaming')
  await newFile.waitFor()
  assert.equal(await newFile.locator('.tree-caret').evaluate(el => getComputedStyle(el).display), 'none')
  await page.keyboard.press('Escape')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
    const plain = await geometry(singleFile)
    assert.equal(await singleFile.locator('.tree-caret').evaluate(el => getComputedStyle(el).display), 'none')
    const alignment = await singlePane.evaluate(el => ({ folder: el.querySelector('.files-root > svg').getBoundingClientRect().x, file: el.querySelector('.tree-row > svg').getBoundingClientRect().x }))
    assert.equal(alignment.folder, alignment.file)
    await shot(`single-${theme}-files`, '.side-pane')
    await singlePane.getByRole('radio', { name: /^更改/ }).check()
    assert.deepEqual(await geometry(singleFile), plain)
    await shot(`single-${theme}-changes`, '.side-pane')
    await singlePane.getByRole('radio', { name: '文件', exact: true }).check()
  }
  checks.push('single-file ordinary chats remove the empty folder gutter and align identically in both views and themes')
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log(JSON.stringify({ checks, shots, hidden: true }, null, 2))
} finally { await app.close() }
