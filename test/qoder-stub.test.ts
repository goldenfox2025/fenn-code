// Qoder signed in, without an account: the real plugin against a stand-in that replays what
// qodercli 1.1.72 / 1.1.73 sends (test/fixtures/qoder-stub.mjs). The real CLI up to sign-in
// is covered by qoder.manual.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const STUB = join(__dirname, 'fixtures/qoder-stub.mjs')
const saved = process.env.QODER_CONFIG_DIR
beforeAll(() => { process.env.QODER_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'qoder-config-')) })
afterAll(() => { if (saved === undefined) delete process.env.QODER_CONFIG_DIR; else process.env.QODER_CONFIG_DIR = saved })

async function qoder(env: Record<string, string> = {}) {
  const made = await makeCore(undefined, env)
  made.store.setBackendSetting('qoder', 'QODER_CLI_PATH', STUB)
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  return made
}
const replies = (store: any, id: string) => store.messagesOf(id).filter((m: any) => m.role === 'assistant')
// The reply reads done a moment before its usage is filled in; the conversation goes idle after both.
const settled = (store: any, id: string, state = 'done') => until(() => store.conversation(id)?.status !== 'working' && replies(store, id).at(-1)?.state === state)

describe.each(['1.1.72', '1.1.73'])('Qoder %s, signed in (replayed)', (version) => {
  it('offers its models, modes and effort, runs a plan and a command, and counts the turn', async () => {
    const { core, store, dispose } = await qoder({ QODER_STUB_VERSION: version })
    try {
      const account = await core.backends.account('qoder')
      expect(account).toMatchObject({ installed: true, signedIn: true, version })
      const conv = await core.startChat({ backendId: 'qoder', text: '先列个计划，然后运行一下' })
      await settled(store, conv.id)
      const c = store.conversation(conv.id)!
      const reply = replies(store, conv.id).at(-1)

      // Session state: models from its model option, mode and effort as options.
      const catalog = await core.backendModels('qoder')
      expect(catalog.models.map((m) => m.id)).toEqual(['auto', 'performance', 'lite'])
      expect(c.sessionOptions?.map((o) => o.category)).toEqual(expect.arrayContaining(['mode', 'thought_level']))
      // Its / commands come in their own update, which may land after the turn ends.
      await until(() => store.conversation(conv.id)?.agentCommands?.length)
      expect(store.conversation(conv.id)!.agentCommands?.map((x) => x.name)).toEqual(['rewind', 'rename', 'goal'])
      expect(c.compactCommand).toBeUndefined() // Qoder's /compact can't run over ACP, so no compress button

      // TodoWrite's plan becomes the plan card.
      expect(c.checklist).toMatch(/✓ 读代码[\s\S]*✱ 改实现[\s\S]*○ 跑测试/)
      // The command it ran shows its output, not a placeholder for a terminal Fenn Code never opened.
      const bash = reply.blocks.find((b: any) => b.type === 'tool' && b.title === 'echo hello-from-terminal')
      expect(bash).toMatchObject({ status: 'completed', output: 'hello-from-terminal\n' })
      // Usage from the prompt result; context from its own log (it sends no usage_update).
      expect(reply.usage).toMatchObject({ input: 1200, output: 80 })
      expect(c.usage).toMatchObject({ contextUsed: 13500, contextSource: 'log' })
      expect(textOf(reply)).toContain('第 1 轮')

      // Changing effort and mode goes through its config options and is echoed back.
      const effort = c.sessionOptions!.find((o) => o.category === 'thought_level')!
      await core.setOption(conv.id, effort.id, 'high')
      await until(() => store.conversation(conv.id)?.sessionOptions?.find((o) => o.id === effort.id)?.current === 'high')
      const mode = c.sessionOptions!.find((o) => o.category === 'mode')!
      await core.setOption(conv.id, mode.id, 'acceptEdits')
      await until(() => store.conversation(conv.id)?.sessionOptions?.find((o) => o.id === mode.id)?.current === 'acceptEdits')
    } finally { await dispose() }
  }, 60000)
})

describe('Qoder compacting on its own (replayed)', () => {
  it("sends the app's notes again after a compaction only its log shows", async () => {
    const { core, store, dispose } = await qoder()
    try {
      const conv = await core.startChat({ backendId: 'qoder', text: '规则在哪' })
      await settled(store, conv.id)
      expect(textOf(replies(store, conv.id).at(-1))).toContain('本条消息：有')
      await core.chat.send(conv.id, '规则在哪')
      expect(textOf(replies(store, conv.id).at(-1))).toContain('本条消息：无')
      await core.chat.send(conv.id, '#压缩 继续')
      expect(store.conversation(conv.id)?.usage?.contextUsed).toBe(3000)
      await core.chat.send(conv.id, '规则在哪')
      expect(textOf(replies(store, conv.id).at(-1))).toContain('本条消息：有')
    } finally { await dispose() }
  }, 60000)
})

describe('Qoder signed out (replayed)', () => {
  it('says how to sign in', async () => {
    const { core, store, dispose } = await qoder({ QODER_STUB_SIGNED_OUT: '1' })
    try {
      expect(await core.backends.account('qoder')).toMatchObject({ installed: true, signedIn: false })
      const conv = await core.startChat({ backendId: 'qoder', text: '你好' }).catch((e) => e)
      if (conv instanceof Error) expect(conv.message).toContain('Qoder 需要登录')
      else {
        await settled(store, conv.id, 'error')
        expect(replies(store, conv.id).at(-1).error).toContain('Qoder 需要登录')
      }
    } finally {
      delete process.env.QODER_STUB_SIGNED_OUT
      await dispose()
    }
  }, 60000)
})

describe('Qoder signed in after it started (replayed)', () => {
  it('works on 重试, without restarting the app', async () => {
    const auth = join(mkdtempSync(join(tmpdir(), 'qoder-auth-')), 'user')
    const { core, store, dispose } = await qoder({ QODER_STUB_AUTH: auth })
    try {
      const conv = await core.startChat({ backendId: 'qoder', text: '你好' })
      await settled(store, conv.id, 'error')
      expect(replies(store, conv.id).at(-1).error).toContain('Qoder 需要登录')
      writeFileSync(auth, '{}') // what `qodercli login` in a terminal leaves behind
      expect(await core.backends.account('qoder')).toMatchObject({ signedIn: true })
      await core.regenerate(conv.id)
      await settled(store, conv.id)
      expect(textOf(replies(store, conv.id).at(-1))).toContain('第 1 轮')
    } finally {
      delete process.env.QODER_STUB_AUTH
      await dispose()
    }
  }, 60000)
})

describe('Qoder 1.1.72 on its free model (replayed)', () => {
  it('fills the ring from the share of the window its log reports, with no token counts made up', async () => {
    const { core, store, dispose } = await qoder({ QODER_STUB_VERSION: '1.1.72', QODER_STUB_ZERO: '1' })
    try {
      const conv = await core.startChat({ backendId: 'qoder', text: '你好' })
      await settled(store, conv.id)
      const u = store.conversation(conv.id)!.usage!
      expect(u).toMatchObject({ contextShare: 0.124635, contextSource: 'log' })
      expect(u.contextUsed).toBeUndefined()
      expect(u.contextSize).toBeUndefined()
    } finally {
      delete process.env.QODER_STUB_ZERO
      await dispose()
    }
  }, 60000)
})
