// Exercise the real DotField component in Electron without agents or user data.
// On macOS the harness also enables native vibrancy. Run from the repository:
// node scripts/dot-field-smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repo, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const { _electron: electron } = require('playwright-core')
const tempRoot = realpathSync(tmpdir())
const temp = mkdtempSync(join(tempRoot, 'fenn-dot-field-'))
const shots = resolve(process.env.FENN_DOT_SHOTS || join(repo, 'release/dot-field-smoke'))
mkdirSync(shots, { recursive: true })
const entry = join(temp, 'index.html')
writeFileSync(entry, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>`)
writeFileSync(join(temp, 'style.css'), `
html,body,#root,.main{margin:0;width:100%;height:100%;overflow:hidden}
body{background:linear-gradient(180deg,rgba(9,10,18,.62),rgba(5,6,10,.72))}
.main{position:relative;--dot-rgb:150,170,190;--dot-alpha:.08;--accent-rgb:61,207,228;--dot-trail:2.6}
${readFileSync(join(repo, 'src/renderer/src/styles/22-dot-field.css'), 'utf8')}
`)
writeFileSync(join(temp, 'entry.tsx'), `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {DotField} from ${JSON.stringify(join(repo, 'src/renderer/src/components/DotField.tsx').replaceAll('\\', '/'))};
const root=createRoot(document.getElementById('root'));
window.renderMode=(fixed,strength=2)=>root.render(<main className="main"><DotField fixed={fixed} strength={strength}/></main>);
window.renderMode(true);
`)
writeFileSync(join(temp, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
app.whenReady().then(()=>{
 const win=new BrowserWindow({width:940,height:680,show:true,backgroundColor:'#00000000',webPreferences:{sandbox:true,contextIsolation:true}});
 win.setMenu(null);
 if(process.platform==='darwin')win.setVibrancy('under-window');
 win.loadFile(${JSON.stringify(join(temp, 'dist/index.html'))});
 win.once('ready-to-show',()=>{win.show();win.focus()});
});
app.on('window-all-closed',()=>app.quit());
`)

let app, page
try {
  await build({ root: temp, configFile: false, logLevel: 'warn', esbuild: { jsx: 'automatic' },
    resolve: { alias: { 'react-dom': join(repo, 'node_modules/react-dom'), react: join(repo, 'node_modules/react') } },
    base: './', build: { outDir: join(temp, 'dist'), emptyOutDir: true } })
  for (const scale of [1, 2]) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    app = await electron.launch({ args: [join(temp, 'main.cjs'), `--user-data-dir=${join(temp, 'profile-' + scale)}`, `--force-device-scale-factor=${scale}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env })
    page = await app.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.waitForFunction(() => {
      const c=document.querySelector('.dot-glow.fixed')
      return c && c.width>0 && c.width===Math.round(innerWidth*devicePixelRatio) && c.height===Math.round(innerHeight*devicePixelRatio)
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
    const geometry = () => page.evaluate(() => {
      const c = document.querySelector('.dot-glow')
      const r = c.getBoundingClientRect()
      return { x:r.x,y:r.y,width:r.width,height:r.height,bufferWidth:c.width,bufferHeight:c.height,
        transform:getComputedStyle(c).transform,willChange:getComputedStyle(c).willChange,dpr:devicePixelRatio }
    })
    const clear = () => page.waitForFunction(() => {
      const c=document.querySelector('.dot-glow')
      if (!c.width || !c.height) return true
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data
      for(let i=3;i<pixels.length;i+=4)if(pixels[i])return false
      return true
    }, undefined, { polling: 100, timeout: 10000 })
    const lit = () => page.waitForFunction(() => {
      const c=document.querySelector('.dot-glow')
      if (!c.width || !c.height) return false
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data
      for(let i=3;i<pixels.length;i+=4)if(pixels[i])return true
      return false
    })
    const fixed = await geometry()
    assert.equal(fixed.dpr, scale)
    assert.equal(fixed.transform, 'none')
    assert.equal(fixed.willChange, 'auto')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await clear()
    const before = await page.screenshot()
    for (const [x,y] of [[120,100],[750,100],[750,520],[150,520],[400,300]]) {
      await page.mouse.move(x,y,{steps:12})
      await lit()
      assert.deepEqual(await geometry(), fixed, 'Pointer motion cannot move or resize the fixed alpha surface')
    }
    await page.screenshot({path:join(shots,`fixed-lit-${scale}x.png`)})
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await clear()
    assert.deepEqual(await geometry(), fixed, 'An empty trail retains its surface')
    const after = await page.screenshot({path:join(shots,`fixed-cleared-${scale}x.png`)})
    assert(before.equals(after), 'Fading restores the exact pre-motion screenshot')

    await page.evaluate(() => window.renderMode(false))
    await page.waitForSelector('.dot-glow:not(.fixed)', { state: 'attached' })
    await page.mouse.move(650,350,{steps:10})
    await lit()
    assert.notEqual((await geometry()).transform,'none','Other platforms retain the small moving canvas')
    await page.evaluate(() => window.renderMode(true))
    await page.waitForFunction(() => {
      const c=document.querySelector('.dot-glow.fixed')
      return c && c.width===document.querySelector('.dot-field').width && getComputedStyle(c).transform==='none'
    })
    await page.mouse.move(200,180,{steps:10})
    await lit()
    assert.equal((await geometry()).willChange,'auto')
    await page.emulateMedia({reducedMotion:'reduce'})
    await clear()
    const still=await geometry()
    await page.mouse.move(700,480,{steps:10})
    await clear()
    assert.deepEqual(await geometry(),still)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(640,400))
    await page.waitForFunction(() => {
      const c=document.querySelector('.dot-glow')
      // Native borders can round a content-size request by one DIP on Windows.
      return Math.abs(innerWidth-640)<=1 && Math.abs(innerHeight-400)<=1 &&
        c.width===Math.round(innerWidth*devicePixelRatio) && c.height===Math.round(innerHeight*devicePixelRatio)
    })
    assert.equal((await geometry()).transform,'none')
    assert.deepEqual(errors,[])
    console.log(`${scale}x: fixed geometry, exact trail cleanup, renderer switching, reduced motion and resize passed`)
    await app.close()
    app=undefined
  }
} catch (error) {
  if (page) console.error(await page.evaluate(() => {
    const c = document.querySelector('.dot-glow')
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      canvas: c && { width: c.width, height: c.height }, focused: document.hasFocus() }
  }).catch(() => 'Renderer unavailable'))
  throw error
} finally {
  if(app)await app.close()
  assert.equal(dirname(temp),tempRoot)
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200})
}
