// Native drag/drop, naming collisions and stable rows through both Library entry points.
// Only hidden disposable profiles and real temporary files; no provider prompts.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { declareTestAgent } from './test-agent.mjs'
import { resizeViewport } from './electron-ui.mjs'

const data = declareTestAgent(mkdtempSync(join(tmpdir(), 'fenn-file-ops-')))
const shots = resolve(process.argv[2] ?? '.local/library-file-operations')
mkdirSync(shots, { recursive: true })
const roots = Object.fromEntries(['chat', 'project'].map(kind => {
  const root = join(mkdtempSync(join(tmpdir(), 'fenn-file-ops-work-')), '文件示例')
  mkdirSync(root); writeFileSync(join(root, '测试'), '原来的文件，不可被覆盖。')
  return [kind, root]
}))
const now = Date.now(), state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'))
state.settings = { ...state.settings, onboarded: true, language: 'zh', theme: 'dark', dotGrid: 0 }
state.projects = [{ id: 'project', name: '项目文件操作', cwd: roots.project, backendId: 'mock', conversationId: 'main', createdAt: now, updatedAt: now }]
state.conversations = [
  { id: 'chat', title: '对话文件操作', kind: 'chat', cwd: roots.chat, backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now },
  { id: 'main', title: '项目文件操作', kind: 'project', projectId: 'project', cwd: roots.project, backendId: 'mock', status: 'idle', createdAt: now, updatedAt: now }
]
writeFileSync(join(data, 'state.json'), JSON.stringify(state))
const app = await electron.launch({ args: ['.'], env: { ...process.env, FENN_DATA_DIR: data, FENN_BACKGROUND_TEST: '1' } })
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(8000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').waitFor(); await page.waitForLoadState('networkidle')
  await resizeViewport(page, { width: 1440, height: 900 })
  const check = []
  for (const kind of ['chat', 'project']) {
    await page.locator('.sidebar .nav-item').filter({ hasText: kind === 'chat' ? '对话文件操作' : '项目文件操作' }).first().click()
    if (kind === 'chat') await page.locator('.side-pane-toggle').click()
    else await page.locator('.panel-head [data-tab=library]').click()
    const surface = page.locator(kind === 'chat' ? '.side-pane' : '.panel')
    await surface.locator(':scope > .pane-viewport > .panel-head').getByRole('button', { name: '全屏', exact: true }).click()
    const pane = surface.locator('.files-pane'), row = path => pane.locator(`.tree-row[data-path="${path}"]`)
    await row('测试').waitFor()
    const measure = async () => row('测试').evaluate(el => ({ icon: el.querySelector('svg').getBoundingClientRect().x, name: el.querySelector('.tree-name').getBoundingClientRect().x }))
    const entryPosition = path => row(path).evaluate(el => ({ icon: el.querySelector('svg:not(.tree-caret)').getBoundingClientRect().x, name: el.querySelector('.tree-name').getBoundingClientRect().x }))
    const initial = await measure()
    const start = async dir => {
      await pane.getByRole('button', { name: '新建或添加文件', exact: true }).click()
      await page.getByRole('menuitem', { name: dir ? '新建文件夹' : '新建文件', exact: true }).click()
      await pane.locator('.tree-input').waitFor()
      return pane.locator('.tree-input')
    }
    let input = await start(true)
    await input.fill('测试'); await input.press('Enter')
    await pane.locator('.name-field-error').waitFor()
    assert.equal(await input.getAttribute('aria-invalid'), 'true')
    assert.equal(readFileSync(join(roots[kind], '测试'), 'utf8'), '原来的文件，不可被覆盖。')
    await page.mouse.move(300, 25)
    await page.screenshot({ path: join(shots, kind + '-collision.png') })
    await input.fill('归档'); await input.press('Enter'); await row('归档').waitFor()
    assert.deepEqual(await measure(), initial, 'adding the first folder shifted the existing file')
    assert.deepEqual(await entryPosition('归档'), initial, 'files and folders at the same depth must align')
    input = await start(false)
    await input.fill('归档'); await input.press('Enter'); await pane.locator('.name-field-error').waitFor()
    assert(statSync(join(roots[kind], '归档')).isDirectory())
    await input.fill('笔记.txt'); await input.press('Enter')
    const editor = pane.locator('.preview-editor'); await pane.locator('.preview-name').filter({ hasText: /^笔记\.txt$/ }).waitFor(); await editor.waitFor(); await editor.fill('编辑后移动的内容。')
    await page.evaluate(() => window.__fennFlushEdits())
    assert.equal(readFileSync(join(roots[kind], '笔记.txt'), 'utf8'), '编辑后移动的内容。')
    // The source is the native draggable row wrapper; the folder is a real drop target.
    await row('测试').locator('..').dragTo(row('归档'))
    await row('归档/测试').waitFor()
    assert(!existsSync(join(roots[kind], '测试')))
    assert.equal(readFileSync(join(roots[kind], '归档/测试'), 'utf8'), '原来的文件，不可被覆盖。')
    await row('笔记.txt').locator('..').dragTo(row('归档'))
    await row('归档/笔记.txt').waitFor(); await editor.waitFor()
    assert.equal(await editor.inputValue(), '编辑后移动的内容。')
    await editor.fill('移动后仍然可以编辑。'); await page.evaluate(() => window.__fennFlushEdits())
    assert.equal(readFileSync(join(roots[kind], '归档/笔记.txt'), 'utf8'), '移动后仍然可以编辑。')
    assert(!existsSync(join(roots[kind], '笔记.txt')))
    await row('归档').focus(); await page.keyboard.press('F2')
    await pane.locator('.tree-input').fill('文档'); await page.keyboard.press('Enter')
    await row('文档/测试').waitFor(); await row('文档/笔记.txt').waitFor()
    input = await start(false); await input.fill('测试'); await input.press('Enter'); await pane.locator('.preview-name').filter({ hasText: /^测试$/ }).waitFor(); await editor.waitFor()
    await editor.fill('重名的另一份内容。'); await page.evaluate(() => window.__fennFlushEdits())
    await row('测试').locator('..').dragTo(row('文档'))
    await page.locator('.toast').filter({ hasText: '这里已经有' }).waitFor()
    assert.equal(readFileSync(join(roots[kind], '测试'), 'utf8'), '重名的另一份内容。')
    assert.equal(readFileSync(join(roots[kind], '文档/测试'), 'utf8'), '原来的文件，不可被覆盖。')
    await page.locator('.toast').filter({ hasText: '这里已经有' }).getByRole('button', { name: '关闭', exact: true }).click()
    await row('测试').focus(); await page.keyboard.press('F2')
    await pane.locator('.tree-input').fill('副本'); await page.keyboard.press('Enter'); await row('副本').waitFor()
    await row('文档/测试').locator('..').dragTo(pane.locator('.files-head'))
    await row('测试').waitFor()
    assert.equal(readFileSync(join(roots[kind], '测试'), 'utf8'), '原来的文件，不可被覆盖。')
    assert.deepEqual(await measure(), initial)
    // Switching creation kind must produce a fresh, usable field.
    input = await start(false); await input.fill('快速新建')
    input = await start(true)
    await input.fill('第二个文件夹'); await input.press('Enter'); await row('第二个文件夹').waitFor()
    await row('文档').locator('..').dragTo(row('第二个文件夹'))
    await row('第二个文件夹/文档/笔记.txt').waitFor()
    assert.equal(readFileSync(join(roots[kind], '第二个文件夹/文档/笔记.txt'), 'utf8'), '移动后仍然可以编辑。')
    const firstLevel = await entryPosition('第二个文件夹/文档')
    const secondLevel = await entryPosition('第二个文件夹/文档/笔记.txt')
    assert.deepEqual(await entryPosition('第二个文件夹'), initial)
    assert.deepEqual(firstLevel, { icon: initial.icon + 12, name: initial.name + 12 })
    assert.deepEqual(secondLevel, { icon: initial.icon + 24, name: initial.name + 24 })
    await row('副本').focus(); await page.keyboard.press('Control+x')
    await row('第二个文件夹').focus(); await page.keyboard.press('Control+v')
    await row('第二个文件夹/副本').waitFor()
    assert.equal(readFileSync(join(roots[kind], '第二个文件夹/副本'), 'utf8'), '重名的另一份内容。')
    await row('第二个文件夹/副本').focus(); await page.keyboard.press('Control+x')
    await pane.getByRole('button', { name: '文件操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '粘贴', exact: true }).click(); await row('副本').waitFor()
    await row('第二个文件夹').focus(); await page.keyboard.press('ArrowLeft')
    assert.equal(await row('第二个文件夹').getAttribute('aria-expanded'), 'false')
    await page.keyboard.press('ArrowRight'); await row('第二个文件夹/文档').waitFor()
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => window.fenn.updateSettings({ theme }), theme)
      await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
      await page.evaluate(async () => {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
        await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))
      })
      await page.mouse.move(300, 25)
      await page.screenshot({ path: join(shots, `${kind}-${theme}-complete.png`) })
    }
    check.push(kind + ': file/folder conflicts, inline recovery, stable row positions, native file/folder moves, preserved editing, duplicate protection, move to root, rapid creation-kind switch, keyboard cut/paste and folder navigation')
    if (kind === 'project') {
      await page.evaluate(() => window.fenn.addToLibrary('project-files:project', '', [
        { name: '参考.txt', data: btoa('reference') }, { name: '保留.txt', data: btoa('keep') }
      ]))
      await pane.getByRole('button', { name: '文件操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '刷新', exact: true }).click()
      await pane.getByRole('button', { name: '添加的资料', exact: true }).click()
      await row('/@materials/参考.txt').locator('..').dragTo(row('第二个文件夹'))
      await row('第二个文件夹/参考.txt').waitFor()
      assert.equal(readFileSync(join(roots[kind], '第二个文件夹/参考.txt'), 'utf8'), 'reference')
      assert.deepEqual(await entryPosition('第二个文件夹/参考.txt'), firstLevel, 'a file and folder at the same nested depth must align')
      await row('副本').click(); await pane.locator('.preview-name').filter({ hasText: /^副本$/ }).waitFor(); await editor.waitFor()
      await row('副本').locator('..').dragTo(pane.getByRole('button', { name: '添加的资料', exact: true }))
      await row('/@materials/副本').waitFor()
      assert.equal((await page.evaluate(() => window.fenn.readLibraryFile('project-files:project', '副本'))).text, '重名的另一份内容。')
      await editor.fill('移入资料后继续编辑。'); await page.evaluate(() => window.__fennFlushEdits())
      assert.equal((await page.evaluate(() => window.fenn.readLibraryFile('project-files:project', '副本'))).text, '移入资料后继续编辑。')
      assert(!existsSync(join(roots[kind], '副本')))
      await row('/@materials/副本').locator('..').dragTo(pane.locator('.files-head'))
      await row('副本').waitFor(); await editor.fill('返回工作文件夹后继续编辑。'); await page.evaluate(() => window.__fennFlushEdits())
      assert.equal(readFileSync(join(roots[kind], '副本'), 'utf8'), '返回工作文件夹后继续编辑。')
      assert.equal(await page.evaluate(() => window.fenn.readLibraryFile('project-files:project', '副本')), undefined)
      check.push('project source mapping: moves and live editing between working files and materials in both directions')
    }
  }
  assert.deepEqual(errors, [])
  assert(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(w => !w.isVisible())))
  console.log(JSON.stringify({ passed: true, check, shots, hidden: true }, null, 2))
} catch (error) {
  await app.windows()[0]?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
  throw error
} finally { await app.close() }
