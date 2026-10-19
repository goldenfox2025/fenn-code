import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { remapMovedPaths } from '../src/main/store/movedFolders'
import { Store } from '../src/main/store/Store'

const win = [{ from: 'C:\\Users\\me\\AppData\\Roaming\\Ancora', to: 'C:\\Users\\me\\AppData\\Roaming\\Fenn Code' }]

describe('paths into a former data folder', () => {
  it('point at the same place in the new folder, on Windows in any case or slash', () => {
    const v = {
      path: 'C:\\Users\\me\\AppData\\Roaming\\Ancora\\data\\workspaces\\a\\功能测试.txt',
      list: ['c:/users/me/appdata/roaming/ancora/data/x.md', 'C:\\Users\\me\\AppData\\Roaming\\Ancora2\\x', 'D:\\Ancora\\x', 'C:\\Users\\me\\AppData\\Roaming\\Ancora notes\\a.txt', 'C:\\Users\\me\\AppData\\Roaming\\Ancora.bak'],
      text: '已写好 C:\\Users\\me\\AppData\\Roaming\\Ancora\\data\\y.md。'
    }
    expect(remapMovedPaths(v, win)).toBe(true)
    expect(v.path).toBe('C:\\Users\\me\\AppData\\Roaming\\Fenn Code\\data\\workspaces\\a\\功能测试.txt')
    expect(v.list).toEqual(['C:\\Users\\me\\AppData\\Roaming\\Fenn Code/data/x.md', 'C:\\Users\\me\\AppData\\Roaming\\Ancora2\\x', 'D:\\Ancora\\x', 'C:\\Users\\me\\AppData\\Roaming\\Ancora notes\\a.txt', 'C:\\Users\\me\\AppData\\Roaming\\Ancora.bak'])
    expect(v.text).toBe('已写好 C:\\Users\\me\\AppData\\Roaming\\Fenn Code\\data\\y.md。')
    expect(remapMovedPaths(v, win)).toBe(false)
  })

  it('keep their case on Linux and macOS', () => {
    const v = { a: '/home/me/.config/Ancora/data/x', b: '/home/me/.config/ancora/data/x' }
    remapMovedPaths(v, [{ from: '/home/me/.config/Ancora', to: '/home/me/.config/Fenn Code' }])
    expect(v).toEqual({ a: '/home/me/.config/Fenn Code/data/x', b: '/home/me/.config/ancora/data/x' })
  })

  it('are rewritten in state and messages already moved, and saved that way', () => {
    const root = mkdtempSync(join(tmpdir(), 'moved-'))
    const old = join(root, 'Ancora')
    const now = join(root, 'Fenn Code')
    const dir = join(now, 'data')
    mkdirSync(join(dir, 'messages'), { recursive: true })
    const file = join(old, 'data', 'workspaces', 'c1', 'report.md')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, projects: [{ id: 'p', name: 'x', conversationId: 'c1', createdAt: 1, updatedAt: 1, outputs: [{ path: file }] }], conversations: [{ id: 'c1', title: 't', cwd: join(old, 'data', 'workspaces', 'c1'), createdAt: 1, updatedAt: 1, status: 'idle' }], routines: [], settings: {}, backendSettings: {} }))
    writeFileSync(join(dir, 'messages', 'c1.json'), JSON.stringify([{ id: 'm', conversationId: 'c1', role: 'assistant', createdAt: 1, blocks: [{ type: 'tool', toolId: 't', title: 'write', paths: [file] }] }]))
    const s = new Store(dir, [{ from: old, to: now }])
    const moved = join(now, 'data', 'workspaces', 'c1', 'report.md')
    expect((s.project('p') as any).outputs[0].path).toBe(moved)
    expect(s.conversation('c1')!.cwd).toBe(join(now, 'data', 'workspaces', 'c1'))
    expect((s.messagesOf('c1')[0].blocks[0] as any).paths).toEqual([moved])
    s.flush()
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).not.toContain(old + '/')
    // As JSON writes it (a Windows path's backslashes doubled).
    expect(readFileSync(join(dir, 'messages', 'c1.json'), 'utf8')).toContain(JSON.stringify(moved))
  })
})
