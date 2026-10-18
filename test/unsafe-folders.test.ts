import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isUnsafeFolder } from '../src/shared/unsafeFolders'
import { makeCore } from './helpers'

describe('folders a chat may never work in', () => {
  it('home, everything above it, drive roots and the data folder', () => {
    const home = 'C:\\Users\\me', data = 'C:\\Users\\me\\AppData\\Roaming\\Fenn Code'
    for (const p of ['C:\\Users\\me', 'c:/users/me/', 'C:\\Users', 'C:\\', 'D:', '/', data, data + '\\workspaces\\x'])
      expect(isUnsafeFolder(p, home, data), p).toBe(true)
    for (const p of ['C:\\Users\\me\\code', 'D:\\code', 'C:\\Users\\me\\Documents\\Fenn Code\\标题'])
      expect(isUnsafeFolder(p, home, data), p).toBe(false)
    expect(isUnsafeFolder('/home/me', '/home/me', '/home/me/.config/Fenn Code')).toBe(true)
    expect(isUnsafeFolder('/home/me/src', '/home/me', '/home/me/.config/Fenn Code')).toBe(false)
  })

  it('refuses them, and moves chats an older version filed there back to no folder', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      await expect(core.startChat({ backendId: 'mock', text: 'x', cwd: homedir() })).rejects.toThrow(/主目录/)
      const c = core.chat.createConversation({ kind: 'chat', title: 'old', backendId: 'mock', cwd: homedir() })
      const ok = core.chat.createConversation({ kind: 'chat', title: 'fine', backendId: 'mock', cwd: join(homedir(), 'code') })
      await expect(core.updateConversation(ok.id, { cwd: '/' })).rejects.toThrow()
      store.patchSettings({ recentFolders: [homedir(), join(homedir(), 'code')] })
      core.leaveUnsafeFolders()
      expect(store.conversation(c.id)?.cwd).toBeUndefined()
      expect(store.conversation(ok.id)?.cwd).toBe(join(homedir(), 'code'))
      expect(store.settings.recentFolders).toEqual([join(homedir(), 'code')])
    } finally { await dispose() }
  })
})
