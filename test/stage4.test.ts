import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FolderFinder, foldersInText, matchingFolders, pathsInText, rankFolders } from '../src/main/core/folders'
import { makeCore } from './helpers'

describe('folders mentioned in a message', () => {
  it('finds Windows, POSIX and ~ paths among Chinese punctuation', () => {
    expect(pathsInText('代码在 C:\\Users\\Alice\\Documents\\openclaude，帮我看看')).toEqual(['C:\\Users\\Alice\\Documents\\openclaude'])
    expect(pathsInText('看「/home/me/app/src/main.ts」。')).toEqual(['/home/me/app/src/main.ts'])
    expect(pathsInText('在 ~/code/site 里')).toEqual(['~/code/site 里'])
    expect(pathsInText('打开D:\\code\\装修看看')).toEqual(['D:\\code\\装修看看'])
    expect(pathsInText('打开 https://example.com/a/b')).toEqual([])
    expect(pathsInText('1/2 或者 a/b')).toEqual([])
    expect(pathsInText('C:/work/site 路径：/srv/www')).toEqual(['C:/work/site 路径：/srv/www', '/srv/www'])
  })

  it('keeps only existing folders, using a file’s own folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
    const app = join(home, 'app')
    mkdirSync(join(app, 'src'), { recursive: true })
    writeFileSync(join(app, 'src', 'main.ts'), '')
    expect(foldersInText(`改一下 ${app}/src/main.ts 和 ${app}/missing`, home)).toEqual([join(app, 'src')])
    expect(foldersInText(`项目在 ~/app 下`, home)).toEqual([app])
    // Spaces inside a path, Chinese text glued to either end, and words after it.
    const spaced = join(home, 'Program Files', 'My App')
    mkdirSync(spaced, { recursive: true })
    mkdirSync(join(home, '装修'))
    expect(foldersInText(`看看${spaced}里的配置`, home)).toEqual([spaced])
    expect(foldersInText(`路径是 ${spaced} 对吧`, home)).toEqual([spaced])
    expect(foldersInText(`打开${join(home, '装修')}，看看`, home)).toEqual([join(home, '装修')])
    // A folder that doesn't exist is not offered as its parent, whatever its name starts with.
    expect(foldersInText(`在 ${app}/newthing 里`, home)).toEqual([])
    expect(foldersInText(`在 ${app}/新文件夹 里`, home)).toEqual([])
    expect(foldersInText(`打开${app}/新文件夹`, home)).toEqual([])
    // Every existing path in a message is found, even after a missing one.
    const other = join(home, 'other')
    mkdirSync(other)
    expect(foldersInText(`比较 ${app} 和 ${other}`, home)).toEqual([app, other])
    expect(foldersInText(`比较 ${home}/gone 和 ${other}`, home)).toEqual([other])
    expect(foldersInText(`看看 /etc 和 /usr/bin`, home)).toEqual([])
    // The home folder itself and a drive root are too broad.
    expect(foldersInText(`在 ${home} 和 / 里`, home)).toEqual([])
  })
})

describe('likely project folders', () => {
  it('finds git repositories under the usual places, skipping their insides and node_modules', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'))
    const repo = (p: string) => mkdirSync(join(home, p, '.git'), { recursive: true })
    repo('Documents/openclaude')
    repo('Documents/openclaude/packages/inner')
    repo('code/garden-planner')
    repo('code/x/node_modules/dep')
    repo('Pictures/not-scanned')
    const finder = new FolderFinder(home)
    const names = (await finder.scan()).map((f) => f.name).sort()
    expect(names).toEqual(['garden-planner', 'openclaude'])
    expect((await finder.suggest('Open Claude 桌面端'))[0].name).toBe('openclaude')
  })

  it('ranks by name match, then recency', () => {
    const list = [
      { path: '/a/site', name: 'site', mtime: 3 },
      { path: '/a/garden-planner', name: 'garden-planner', mtime: 1 },
      { path: '/a/notes', name: 'notes', mtime: 2 }
    ]
    expect(rankFolders(list, 'garden planner').map((f) => f.name)).toEqual(['garden-planner', 'site', 'notes'])
    expect(matchingFolders(list, '我的 notes')).toEqual([list[2]])
    expect(matchingFolders(list, '')).toEqual([])
  })

  it('remembers chosen folders, newest first', async () => {
    const { core, store, dispose } = await makeCore()
    const a = mkdtempSync(join(tmpdir(), 'oc-a-'))
    const b = mkdtempSync(join(tmpdir(), 'oc-b-'))
    await core.createProject({ name: 'p', cwd: a, backendId: 'mock' })
    const c = await core.startChat({ text: '你好', backendId: 'mock', cwd: b })
    await core.updateConversation(c.id, { cwd: a })
    expect(store.settings.recentFolders).toEqual([a, b])
    await dispose()
  }, 30000)
})
