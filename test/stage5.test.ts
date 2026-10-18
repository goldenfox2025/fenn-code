import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAccountCheck } from '../src/main/backends/acp'
import qoder, { qoderAccount } from '../src/main/backends/plugins/qoder'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const idle = (store: any, id: string, n: number) =>
  until(() => store.messagesOf(id).filter((m: any) => m.role === 'assistant' && m.state === 'done').length >= n && store.conversation(id)?.status === 'idle')

describe('session options (mode, thinking level)', () => {
  it('shows what the agent offers, and a mode change takes effect in the session', async () => {
    const { core, store, events, dispose } = await makeCore()
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, c.id, 1)
    const opts = store.conversation(c.id)!.sessionOptions!
    expect(opts.map((o) => [o.id, o.category, o.current])).toEqual([['mode', 'mode', 'default'], ['effort', 'thought_level', 'medium']])
    // The backend's list is remembered for the next new chat's picker.
    expect(store.settings.backendModels!.mock.options!.map((o) => o.id)).toEqual(['mode', 'effort'])

    await core.setOption(c.id, 'mode', 'acceptEdits')
    expect(store.conversation(c.id)!.sessionOptions!.find((o) => o.id === 'mode')!.current).toBe('acceptEdits')
    const asked = events.filter((e) => e.type === 'permission').length
    await core.send(c.id, '写一份笔记')
    await idle(store, c.id, 2)
    expect(events.filter((e) => e.type === 'permission').length).toBe(asked)
    const last = store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()!
    expect(textOf(last)).toContain('模式：`acceptEdits`')

    // The choice belongs to the conversation: a new session (e.g. after a folder change) gets it again.
    core.chat.forgetSession(c.id)
    await core.send(c.id, '再来')
    await idle(store, c.id, 3)
    expect(store.conversation(c.id)!.sessionOptions!.find((o) => o.id === 'mode')!.current).toBe('acceptEdits')
    await dispose()
  }, 30000)

  it('starts new chats with the default thinking level, but a mode only for the chat it was picked for', async () => {
    const { core, store, dispose } = await makeCore()
    await core.setOptionDefault('mock', 'effort', 'high')
    // An earlier version could save a mode as a default; it must not reach new chats.
    await core.setOptionDefault('mock', 'mode', 'bypassPermissions')
    const a = await core.startChat({ text: '你好', backendId: 'mock', optionValues: { mode: 'acceptEdits', effort: 'nonsense' } })
    await idle(store, a.id, 1)
    const oa = store.conversation(a.id)!.sessionOptions!
    expect(oa.find((o) => o.id === 'mode')!.current).toBe('acceptEdits')
    // A value the agent doesn't offer is ignored.
    expect(oa.find((o) => o.id === 'effort')!.current).toBe('medium')
    const b = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, b.id, 1)
    const ob = store.conversation(b.id)!.sessionOptions!
    expect(ob.find((o) => o.id === 'mode')!.current).toBe('default')
    expect(ob.find((o) => o.id === 'effort')!.current).toBe('high')
    await dispose()
  }, 30000)
})

describe('session modes from older ACP agents', () => {
  it('offers session modes as a mode option and switches with session/set_mode', async () => {
    const { core, store, dispose } = await makeCore(undefined, { MOCK_LEGACY_MODES: '1' })
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, c.id, 1)
    const mode = store.conversation(c.id)!.sessionOptions!.find((o) => o.category === 'mode')!
    expect(mode.choices.map((x) => x.value)).toEqual(['default', 'plan'])
    await core.setOption(c.id, mode.id, 'plan')
    await core.send(c.id, '继续')
    await idle(store, c.id, 2)
    const last = store.messagesOf(c.id).filter((m) => m.role === 'assistant').pop()!
    expect(textOf(last)).toContain('模式：`plan`')
    await dispose()
  }, 30000)
})

describe('backends that are gone', () => {
  it('moves chats, projects and the default to a backend that exists', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '你好', backendId: 'mock' })
    await idle(store, c.id, 1)
    const p = await core.createProject({ name: 'x', backendId: 'mock' })
    store.putConversation({ ...store.conversation(c.id)!, backendId: 'removed-demo' })
    store.putProject({ ...store.project(p.id)!, backendId: 'removed-demo' })
    store.patchSettings({ defaultBackendId: 'removed-demo' })
    core.repairBackends()
    // The first installed agent; with none installed the default stays empty (never an uninstalled agent),
    // and the chats show their history under Codex. This depends on the machine running the test.
    const installed = core.backends.list().find((b) => b.installed === true)?.id
    const next = installed ?? 'codex'
    expect(store.settings.defaultBackendId).toBe(installed ?? '')
    expect(store.conversation(c.id)!.backendId).toBe(next)
    expect(store.conversation(c.id)!.sessionRef).toBeUndefined()
    expect(store.project(p.id)!.backendId).toBe(next)
    // The history stays.
    expect(store.messagesOf(c.id).length).toBeGreaterThan(1)
    await dispose()
  }, 30000)

  it('leaves custom backends alone while backends.json is broken, so fixing the file brings them back', async () => {
    const { core, store, dispose } = await makeCore()
    const c = core.chat.createConversation({ kind: 'chat', title: 'x', backendId: 'my-agent', modelId: 'm1', optionValues: { mode: 'plan' } })
    const d = core.chat.createConversation({ kind: 'chat', title: 'y', backendId: 'mock' })
    store.putConversation({ ...d, backendId: 'removed-demo' })
    store.patchSettings({ defaultBackendId: 'my-agent' })
    core.backendsConfigError = 'backends.json 第 3 行有多余的逗号'
    core.repairBackends()
    expect(store.settings.defaultBackendId).toBe('my-agent')
    expect(store.conversation(c.id)).toMatchObject({ backendId: 'my-agent', modelId: 'm1', optionValues: { mode: 'plan' } })
    expect(store.conversation(d.id)!.backendId).toBe('removed-demo')
    // Once the file reads fine, a backend that is really gone is repaired as before.
    core.backendsConfigError = undefined
    core.repairBackends()
    expect(store.conversation(c.id)!.backendId).toBe(core.backends.list().find((b) => b.installed === true)?.id ?? 'codex')
    await dispose()
  }, 30000)
})

describe('sign-in state', () => {
  it('reads a status command, and says when the program is not installed', async () => {
    const ok = await runAccountCheck({
      command: process.execPath,
      args: ['-e', 'console.log("noise\\n" + JSON.stringify({ logged_in: true, version: "9.9" }))'],
      parse: (out) => ({ signedIn: JSON.parse(out.slice(out.indexOf('{'))).logged_in, detail: 'v9.9' })
    })
    expect(ok).toEqual({ signedIn: true, detail: 'v9.9' })
    expect(await runAccountCheck({ command: 'no-such-program-oc', parse: () => ({ signedIn: true }) })).toEqual({ installed: false })
  })

  it('knows the Qoder status format', () => {
    const { parse, args } = qoderAccount({})
    // Run through Node with the package's JS entry when qodercli is an npm shim on this machine.
    expect(args?.slice(-3)).toEqual(['status', '-o', 'json'])
    expect(parse('{"logged_in": false, "version": "1.1.70", "allow_byok": 0}')).toEqual({ installed: true, version: '1.1.70', signedIn: false, detail: 'qodercli 1.1.70' })
    // 1.1.72 and later: username/email, and why sign-in failed.
    expect(parse('{"logged_in": true, "version": "1.1.72", "username": "alex", "email": "alex@example.com", "plan": "pro"}').detail).toBe('alex@example.com · qodercli 1.1.72')
    expect(parse('{"logged_in": false, "version": "1.1.72", "auth_error_message": "token expired"}').detail).toBe('token expired · qodercli 1.1.72')
    expect(parse('{"logged_in": true, "version": "1.2.0", "account": "alex@example.com"}')).toEqual({ installed: true, version: '1.2.0', signedIn: true, detail: 'alex@example.com · qodercli 1.2.0' })
  })

  const real = process.env.QODERCLI_BIN
  it.skipIf(!real || !existsSync(real))('asks the real qodercli', async () => {
    const dir = join(real!, '..')
    process.env.PATH = `${dir}:${process.env.PATH}`
    const a = await qoder.account!({})
    expect(a.signedIn).toBe(false)
    expect(a.detail).toMatch(/^qodercli \d/)
  }, 30000)
})

