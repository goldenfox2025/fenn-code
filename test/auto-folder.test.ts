import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderSafeName, uniqueDir } from '../src/main/core/autoFolder'
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
    const { core, store, dir, dispose } = await makeCore()
    const mine = join(dir, 'mine')
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

  it('numbers a folder whose name is taken', () => {
    expect(uniqueDir(process.cwd(), 'test')).toBe(join(process.cwd(), 'test 2'))
  })
})
