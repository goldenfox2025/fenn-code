import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'
import { BrowserTools } from '../src/main/browser/BrowserTools'
import { BrowserPermissions } from '../src/main/browser/BrowserPermissions'
import { ToolContent } from '../src/main/tools/ToolServer'

let server: Server, url: string, submissions = 0
const data = mkdtempSync(join(tmpdir(), 'fenn-browser-test-'))
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html;charset=utf-8')
    if (req.url === '/submit') { submissions++; res.end('ok'); return }
    res.end('<!doctype html><title>Owned test page</title><label>Note<input aria-label="Note"></label><button onclick="fetch(\'/submit\').then(()=>document.body.dataset.saved=\'yes\')">Save</button><p>' + (req.url === '/second' ? 'Second page' : 'First page') + '</p>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
const decode = (value: unknown) => JSON.parse((value as ToolContent).content.find(item => item.type === 'text')!.text!)
const invoke = (engine: BrowserTools, id: string, runId: string, name: string, args: Record<string, unknown> = {}) => engine.tools(id, runId).find(tool => tool.name === name)!.run(args, { conversationId: id })

it('runs headless, separates owners, confirms side effects, streams frames and stops stale control', async () => {
  let allow = true
  const requests: string[] = []
  const policy = new BrowserPermissions(async (_id, request) => { requests.push(request.title); return allow ? 'task' : 'deny' })
  const run = policy.begin('a'), other = policy.begin('b')
  const engine = new BrowserTools(data, () => ({ browserMode: 'isolated' }), policy)
  try {
    const opened = decode(await invoke(engine, 'a', run, 'browser_open', { url }))
    expect(opened.text).toContain('First page')
    expect((await engine.frame('a'))?.image).toBeTruthy()
    const input = opened.elements.find((item: { tag: string }) => item.tag === 'input')
    const filled = decode(await invoke(engine, 'a', run, 'browser_fill', { ref: input.ref, text: 'accepted text' }))
    allow = false
    const button = filled.elements.find((item: { tag: string }) => item.tag === 'button')
    await expect(invoke(engine, 'a', run, 'browser_click', { ref: button.ref })).rejects.toThrow('未获授权')
    expect(submissions).toBe(0)
    expect(requests.at(-1)).toBe('点击网页元素')
    allow = true
    decode(await invoke(engine, 'b', other, 'browser_open', { url: url + '/second' }))
    await expect(invoke(engine, 'b', other, 'browser_fill', { ref: input.ref, text: 'cross-owner' })).rejects.toThrow('失效')
    expect((await engine.frame('a'))?.url).toBe(url + '/')
    expect((await engine.frame('b'))?.url).toBe(url + '/second')
    await invoke(engine, 'a', run, 'browser_click', { ref: button.ref })
    expect(submissions).toBe(1)
    policy.end('a'); await engine.stop('a')
    expect((await engine.frame('a'))?.active).toBe(false)
    await expect(invoke(engine, 'a', run, 'browser_snapshot')).rejects.toThrow('停止')
  } finally { policy.end('a'); policy.end('b'); await engine.close() }
}, 40_000)

it('opens an existing-browser tab in the background, asks which browser and leaves user tabs intact', async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()))
  let context: BrowserContext | undefined
  let chosen = 0
  const policy = new BrowserPermissions(async (_id, request) => request.title === '选择要使用的浏览器' ? (chosen++, request.options[0].id) : 'task')
  const run = policy.begin('existing')
  const engine = new BrowserTools(join(data, 'existing'), () => ({ browserMode: 'existing', cdpUrl: `http://127.0.0.1:${port}` }), policy)
  try {
    context = await chromium.launchPersistentContext(join(data, 'user'), { channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`] })
    const original = context.pages()[0]; await original.goto(url)
    await original.bringToFront()
    const before = await original.evaluate(() => document.visibilityState)
    const available = await engine.discover()
    expect(available.some(item => item.id.endsWith(`:${port}`))).toBe(true)
    engine.discover = async () => [{ id: `http://127.0.0.1:${port}`, label: 'Owned fixture' }, { id: 'http://127.0.0.1:1', label: 'Unavailable fixture' }]
    await invoke(engine, 'existing', run, 'browser_open', { url: url + '/second' })
    expect(chosen).toBe(1)
    expect(original.url()).toBe(url + '/')
    expect(await original.evaluate(() => document.visibilityState)).toBe(before)
    expect(context.pages()).toHaveLength(2)
    expect((await engine.frame('existing'))?.mode).toBe('existing')
    policy.end('existing'); await engine.stop('existing')
    expect((await engine.frame('existing'))?.active).toBe(false)
    await expect(invoke(engine, 'existing', run, 'browser_snapshot')).rejects.toThrow('停止')
    expect(context.pages()).toHaveLength(1)
  } finally { policy.end('existing'); await engine.close(); await context?.close() }
}, 40_000)
