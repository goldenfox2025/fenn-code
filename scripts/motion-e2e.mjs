// Hidden owned-app checks. Source profiles must declare a deterministic ACP fixture.
import { _electron as electron } from 'playwright-core';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const [codeProfile, botProfile, botRoot] = process.argv.slice(2);
if (!codeProfile || !botProfile || !botRoot) throw Error('Pass isolated Code/Bot fixture profiles and Bot source root.');
const report = [];
for (const item of [{ kind: 'code', source: codeProfile, cwd: resolve('.') }, { kind: 'bot', source: botProfile, cwd: resolve(botRoot) }]) {
  const configured = JSON.parse(readFileSync(join(item.source, 'backends.json'), 'utf8'));
  assert(configured.some(backend => ['mock', 'fixture'].includes(backend.id)), 'Test profile must have a fixture ACP backend');
  const data = mkdtempSync(join(tmpdir(), 'fenn-motion-' + item.kind + '-'));
  for (const name of ['state.json', 'backends.json', 'messages', 'projects', 'bots']) if (existsSync(join(item.source, name))) cpSync(join(item.source, name), join(data, name), { recursive: true });
  const state = JSON.parse(readFileSync(join(data, 'state.json'), 'utf8'));
  if (item.kind === 'code') state.settings = { ...state.settings, theme: 'light', language: 'zh', onboarded: true };
  else state.config.theme = 'light';
  writeFileSync(join(data, 'state.json'), JSON.stringify(state));
  const env = { ...process.env, FENN_BACKGROUND_TEST: '1', FENN_BOT_BACKGROUND: '1', FENN_BOT_TEST: '1' };
  delete env.FENN_DATA_DIR; delete env.FENN_BOT_DATA;
  env[item.kind === 'code' ? 'FENN_DATA_DIR' : 'FENN_BOT_DATA'] = data;
  const app = await electron.launch({ args: ['.'], cwd: item.cwd, env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(12000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator(item.kind === 'code' ? '.sidebar' : '.bot-app').waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    if (item.kind === 'code') await page.locator('.sidebar .nav-item').filter({ hasText: '回复页脚 · 测试数据' }).click();
    const opener = item.kind === 'code' ? '.side-pane-toggle' : '.heading-name';
    const pane = item.kind === 'code' ? '.side-pane' : '.task-inspector';
    const closer = item.kind === 'code' ? '.side-pane .panel-head button[aria-label="关闭"]' : '.task-inspector button[aria-label="收起侧面板"]';
    const settle = () => page.evaluate(async () => { await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); await Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    await settle(); await page.locator(opener).click(); await page.locator(pane).waitFor(); await settle();
    const nodes = page.locator('.conversation-nodes');
    await nodes.waitFor();
    await nodes.locator('.conversation-node').first().hover();
    await page.locator('.node-preview').waitFor();
    const gutter = await page.evaluate(kind => {
      const nav = document.querySelector('.conversation-nodes').getBoundingClientRect();
      const shell = document.querySelector(kind === 'bot' ? '.history-wrap' : '.transcript-shell').getBoundingClientRect();
      const preview = document.querySelector('.node-preview').getBoundingClientRect();
      const content = [...document.querySelectorAll(kind === 'bot' ? '.message' : '.msg .md, .msg-user .bubble')].map(el => el.getBoundingClientRect()).filter(r => r.width > 0);
      return { left: Math.abs(nav.left-shell.left), contentCount: content.length, noOverlap: content.every(r => r.left >= nav.right), contained: preview.left >= nav.right && preview.right <= shell.right && preview.top >= shell.top && preview.bottom <= shell.bottom };
    }, item.kind);
    assert(gutter.contentCount > 0 && Math.abs(gutter.left - 8) < 1 && gutter.noOverlap && gutter.contained, item.kind + ' node gutter keeps an 8px edge inset, stays outside prose/bubbles and contains its preview: ' + JSON.stringify(gutter));
    await nodes.locator('.conversation-node').first().focus(); await page.keyboard.press('Escape');
    const cycles = [];
    for (let i = 0; i < 6; i++) {
      const sample = await page.evaluate(async ({ opener, pane, closer }) => {
        const frame = () => new Promise(r => requestAnimationFrame(r));
        const x = () => { const style = getComputedStyle(document.querySelector(pane)); return style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m41; };
        const started = performance.now(); document.querySelector(closer).click(); await frame();
        if (!document.querySelector(pane)) return { missed: performance.now() - started, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, duration: getComputedStyle(document.documentElement).getPropertyValue('--dur-2') };
        // Fix the sampled progress, not the frame clock of a hidden Windows
        // surface; real rAF/long-task observations are measured separately below.
        const transition = document.querySelector(pane).getAnimations().find(animation => animation.transitionProperty === 'transform');
        if (!transition) throw Error('Pane has no interruptible transform transition');
        transition.pause(); transition.currentTime = Number(transition.effect.getTiming().duration) * .35;
        const before = x();
        document.querySelector(opener).click(); await frame();
        return { before, after: x(), opaque: getComputedStyle(document.querySelector(pane)).opacity, inert: document.querySelector(pane).inert };
      }, { opener, pane, closer });
      assert(!sample.missed, item.kind + ' missed interruption window: ' + JSON.stringify(sample));
      assert(sample.before > 0 && sample.before < 16, 'sample must interrupt an actual closing transition: ' + JSON.stringify(sample));
      assert(sample.after <= sample.before + 3 && sample.after < 15.5, 'reopening continues from its current pose instead of restarting at the hidden edge: ' + JSON.stringify(sample));
      assert.equal(sample.opaque, '1'); assert.equal(sample.inert, false);
      await settle(); cycles.push(sample);
    }
    const frames = await page.evaluate(async kind => {
      const gaps = [], tasks = []; let last = performance.now();
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) tasks.push(entry.duration); }); observer.observe({ type: 'longtask', buffered: false });
      const replies = [...document.querySelectorAll(kind === 'bot' ? '.message.assistant' : '.msg-assistant.turn')].slice(-6);
      if (!replies.length) throw Error('No reply content in the motion fixture');
      for (let i = 0; i < 45; i++) { replies[i % Math.max(1, replies.length)]?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); await new Promise(r => requestAnimationFrame(r)); const now = performance.now(); gaps.push(now - last); last = now; }
      observer.disconnect(); gaps.sort((a, b) => a - b);
      return { p95: gaps[Math.floor(gaps.length * .95)], worst: gaps.at(-1), longTasks: tasks };
    }, item.kind);
    assert(!frames.longTasks.some(duration => duration > 200), 'routine hover must not stall the renderer for 200ms');
    const layout = await page.evaluate(async ({ kind, closer }) => {
      const main = document.querySelector(kind === 'bot' ? '.bot-main' : '.workspace > .center');
      const widths = [main.getBoundingClientRect().width];
      document.querySelector(closer).click();
      for(let i=0;i<24;i++){await new Promise(resolve=>requestAnimationFrame(resolve));widths.push(main.getBoundingClientRect().width)}
      const delta=widths.at(-1)-widths[0];
      const maxStep=Math.max(...widths.slice(1).map((width,index)=>Math.abs(width-widths[index])));
      return {widths,delta,maxStep};
    }, { kind:item.kind, closer });
    assert(layout.delta > 100, 'closing releases the pane space');
    assert(layout.widths.some(width => width > layout.widths[0] + 5 && width < layout.widths.at(-1) - 5), 'layout contracts together with the pane, not at final unmount');
    assert(layout.maxStep < layout.delta * .55, 'closing must not release most of the width in one frame: '+JSON.stringify(layout));
    await page.locator(opener).click();await settle();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator(closer).click(); await page.locator(pane).waitFor({ state: 'detached' });
    await page.locator(opener).click(); await page.locator(pane).waitFor();
    assert.equal(await page.locator(pane).evaluate(el => { const t=getComputedStyle(el).transform; return t === 'none' ? 0 : new DOMMatrixReadOnly(t).m41; }), 0);
    report.push({ kind: item.kind, gutter, cycles, frames, layout, reducedMotion: true });
    console.log('PASS', item.kind, 'six interrupted close/reopen cycles, opaque settled panes, reduced motion; hover frame sample', JSON.stringify(frames));
  } finally { await app.close(); }
}
mkdirSync('.local', { recursive: true }); writeFileSync('.local/oct25-motion.json', JSON.stringify(report, null, 2));
