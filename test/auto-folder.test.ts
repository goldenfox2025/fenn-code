import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderSafeName, moveContents, uniqueDir } from '../src/main/core/autoFolder'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

describe('folders for chats', () => {
  it('names folders safely on every system', () => {
    expect(folderSafeName('整理 发票: 2026/10?')).toBe('整理 发票 2026 10')
    expect(folderSafeName('CON')).toBe('Ancora')
    expect(folderSafeName('  ...  ', '新对话')).toBe('新对话')
    expect(folderSafeName('a'.repeat(100))).toHaveLength(60)
  })

  it('gives a chat that made files a readable folder, and moves the files in', async () => {
    const { core, store, dir, dispose } = await makeCore()
    const c = await core.startChat({ text: '写文件 notes.md', backendId: 'mock' })
    await until(() => store.conversation(c.id)?.autoFolder)
    const conv = store.conversation(c.id)!
    expect(conv.cwd!.startsWith(join(dir, 'Documents', 'Ancora'))).toBe(true)
    expect(existsSync(join(conv.cwd!, 'notes.md'))).toBe(true)
    expect(existsSync(core.chat.scratchPath(c.id))).toBe(false)
    // Not offered as a folder the user chose.
    expect(store.settings.recentFolders ?? []).not.toContain(conv.cwd)
    const reply = store.messagesOf(c.id).find((m) => m.role === 'assistant')!
    expect(reply.blocks).toContainEqual({ type: 'placed', path: conv.cwd })
    // The agent carries on in the new folder.
    await core.send(c.id, '你在哪里工作')
    await until(() => store.messagesOf(c.id).filter((m) => m.role === 'assistant' && m.state === 'done').length === 2)
    expect(textOf(store.messagesOf(c.id).at(-1)!)).toContain(conv.cwd!)
    await dispose()
  }, 30000)

  it('runs commands with no folder yet, and takes a folder the user picks on a prompt as its working folder', async () => {
    const { core, store, dispose, answerWith } = await makeCore()
    const c = await core.startChat({ text: '后台运行 node -e 1', backendId: 'mock' })
    await until(() => store.messagesOf(c.id).some((m) => m.role === 'assistant' && m.state === 'done'))
    expect(textOf(store.messagesOf(c.id).at(-1)!)).toContain('已在后台运行')
    // Outside the app's data folder (here the test's dir), like the user's Desktop.
    const desk = join(mkdtempSync(join(tmpdir(), 'oc-desk-')), 'Desktop')
    mkdirSync(desk)
    let offered: string[] = []
    answerWith((r) => ((offered = r.options.map((o) => o.label)), r.options.find((o) => o.id === 'adopt')?.id ?? 'reject'))
    await core.send(c.id, `在 ${desk} 运行 node -e 1`)
    await until(() => store.conversation(c.id)?.cwd === desk)
    expect(offered).toContain('设为工作文件夹：Desktop')
    expect(store.conversation(c.id)!.autoFolder).toBeUndefined()
    expect(store.settings.recentFolders).toContain(desk)
    await until(() => store.conversation(c.id)?.status === 'idle')
    // The next turn's session starts in that folder.
    await core.send(c.id, '你在哪里工作')
    await until(() => store.messagesOf(c.id).filter((m) => m.role === 'assistant' && m.state === 'done').length === 3)
    expect(textOf(store.messagesOf(c.id).at(-1)!)).toContain(desk)
    await dispose()
  }, 30000)

  it('moves files into a folder the user already has without replacing theirs', () => {
    const from = mkdtempSync(join(tmpdir(), 'oc-mv-'))
    const to = mkdtempSync(join(tmpdir(), 'oc-mv-'))
    writeFileSync(join(from, 'a.txt'), 'agent')
    writeFileSync(join(from, 'b.txt'), 'agent')
    writeFileSync(join(to, 'a.txt'), 'mine')
    moveContents(from, to, { keepExisting: true })
    expect(readFileSync(join(to, 'a.txt'), 'utf8')).toBe('mine')
    expect(readFileSync(join(to, 'b.txt'), 'utf8')).toBe('agent')
    expect(readdirSync(from)).toEqual(['a.txt'])
  })

  it('leaves a chat that only talks without a folder', async () => {
    const { core, store, dir, dispose } = await makeCore()
    const c = await core.startChat({ text: '给我讲讲番茄怎么种', backendId: 'mock' })
    await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).length >= 2)
    await new Promise((r) => setTimeout(r, 1500))
    expect(store.conversation(c.id)?.cwd).toBeUndefined()
    expect(existsSync(join(dir, 'Documents', 'Ancora')) ? readdirSync(join(dir, 'Documents', 'Ancora')) : []).toEqual([])
    await dispose()
  }, 30000)

  it('never takes the place of a folder the user picked, and picking one clears the mark', async () => {
    const { core, store, dispose } = await makeCore()
    // Outside Ancora's data folder, which is never a working folder.
    const mine = join(mkdtempSync(join(tmpdir(), 'oc-mine-')), 'mine')
    mkdirSync(mine)
    const c = await core.startChat({ text: '写文件 a.txt', backendId: 'mock', cwd: mine })
    await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).length >= 2)
    expect(await core.placeChat(c.id)).toBeUndefined()
    expect(store.conversation(c.id)?.cwd).toBe(mine)
    expect(existsSync(join(mine, 'a.txt'))).toBe(true)
    // An app-made folder the user then picks for themselves loses the mark.
    store.putConversation({ ...store.conversation(c.id)!, autoFolder: true })
    await core.updateConversation(c.id, { cwd: mine })
    expect(store.conversation(c.id)?.autoFolder).toBeUndefined()
    await dispose()
  }, 30000)

  it('makes no folder for hidden files alone', async () => {
    const { core, store, dispose } = await makeCore()
    const c = await core.startChat({ text: '写文件 .agentrc', backendId: 'mock' })
    await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).length >= 2)
    await new Promise((r) => setTimeout(r, 1500))
    expect(store.conversation(c.id)?.cwd).toBeUndefined()
    expect(existsSync(join(core.chat.scratchPath(c.id), '.agentrc'))).toBe(true)
    await dispose()
  }, 30000)

  it('numbers a folder whose name is taken', () => {
    expect(uniqueDir(process.cwd(), 'test')).toBe(join(process.cwd(), 'test 2'))
  })
})

describe('one default folder', () => {
  it('a new project without a folder gets its own under it; the old 常用文件夹 setting folds into it', async () => {
    const { core, store, dir, dispose } = await makeCore()
    try {
      const p = await core.createProject({ name: '竞品/定价', backendId: 'mock' })
      expect(p.cwd).toBe(join(dir, 'Documents', 'Ancora', folderSafeName('竞品/定价', '')))
      expect(existsSync(p.cwd!)).toBe(true)
      const q = await core.createProject({ name: '竞品/定价', backendId: 'mock' })
      expect(q.cwd).not.toBe(p.cwd)
      const mine = mkdtempSync(join(tmpdir(), 'oc-root-'))
      store.patchSettings({ defaultCwd: mine })
      // A project an older version put in the home folder loses it.
      const home = await core.createProject({ name: '旧项目', backendId: 'mock' })
      store.putProject({ ...store.project(home.id)!, cwd: homedir() })
      // Its chat kept a copy of the path; that goes too, or the coordinator would still open there.
      store.putConversation({ ...store.conversation(home.conversationId)!, cwd: homedir() })
      core.leaveUnsafeFolders()
      expect(store.conversation(home.conversationId)!.cwd).toBeUndefined()
      expect(core.chat.folderOf(store.conversation(home.conversationId)!)).toBeUndefined()
      // The old 常用文件夹 was a place to work in, not the root for new folders: it stays a recent folder.
      expect(store.settings.autoFolderRoot).toBeUndefined()
      expect(store.settings.recentFolders?.[0]).toBe(mine)
      expect(store.settings.defaultCwd).toBeUndefined()
      expect(store.project(home.id)!.cwd).toBeUndefined()
    } finally { await dispose() }
  })

  it('「在默认文件夹里新建」 gives a talking chat its folder at once', async () => {
    const { core, store, dir, dispose } = await makeCore()
    try {
      const c = await core.startChat({ text: '给我讲讲番茄怎么种', backendId: 'mock' })
      await until(() => store.conversation(c.id)?.status === 'idle' && store.messagesOf(c.id).length >= 2)
      const path = await core.makeDefaultFolder(c.id)
      expect(path.startsWith(join(dir, 'Documents', 'Ancora'))).toBe(true)
      expect(existsSync(path)).toBe(true)
      expect(store.conversation(c.id)).toMatchObject({ cwd: path, autoFolder: true })
      expect(await core.makeDefaultFolder(c.id)).toBe(path)
      expect((await core.listLibrary(c.id))?.root).toBe(path)
    } finally { await dispose() }
  }, 30000)
})

describe('messages sent while a reply runs', () => {
  it('wait in view, and 停止 hands them back instead of dropping them', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const c = await core.startChat({ text: '#啰嗦慢', backendId: 'mock' })
      await until(() => store.conversation(c.id)?.status === 'working')
      void core.send(c.id, '排队一')
      await until(() => store.conversation(c.id)?.queued?.length === 1)
      expect(store.conversation(c.id)!.queued).toMatchObject([{ text: '排队一' }])
      const back = await core.cancel(c.id)
      expect(back).toMatchObject([{ text: '排队一' }])
      expect(store.conversation(c.id)!.queued).toBeUndefined()
      await until(() => store.conversation(c.id)?.status !== 'working')
      expect(store.messagesOf(c.id).some((m) => textOf(m) === '排队一')).toBe(false)
    } finally { await dispose() }
  }, 30000)

  it('can be taken back for editing, or sent now, which stops the reply and goes next', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const c = await core.startChat({ text: '#啰嗦慢', backendId: 'mock' })
      await until(() => store.conversation(c.id)?.status === 'working')
      void core.send(c.id, '排队一')
      void core.send(c.id, '排队二')
      await until(() => store.conversation(c.id)?.queued?.length === 2)
      const [one, two] = store.conversation(c.id)!.queued!
      expect(await core.queuedMessage(c.id, one.id, 'take')).toMatchObject({ text: '排队一' })
      expect(store.conversation(c.id)!.queued).toMatchObject([{ text: '排队二' }])
      await core.queuedMessage(c.id, two.id, 'now')
      await until(() => store.messagesOf(c.id).some((m) => m.role === 'user' && textOf(m) === '排队二'))
      const first = store.messagesOf(c.id).find((m) => m.role === 'assistant')!
      expect(first.state).toBe('cancelled')
      await until(() => store.conversation(c.id)?.status === 'idle')
      expect(store.conversation(c.id)!.queued).toBeUndefined()
      expect(store.messagesOf(c.id).some((m) => textOf(m) === '排队一')).toBe(false)
    } finally { await dispose() }
  }, 30000)
})
