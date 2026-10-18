import { describe, expect, it } from 'vitest'
import { folderOfTurn } from '../src/main/core/AutoAssigner'
import { localTitle } from '../src/main/core/titles'

const reply = (...inputs: string[]) =>
  ({ blocks: inputs.map((input, i) => ({ type: 'tool', toolId: String(i), title: 'Read', status: 'completed', input })) }) as any

describe('tidying a new chat', () => {
  it('makes the title from what the user wrote, without asking any agent', () => {
    expect(localTitle('帮我规划去京都的三天行程。')).toBe('规划去京都的三天行程')
    expect(localTitle('请帮我写一份周报的提纲')).toBe('写一份周报的提纲')
    expect(localTitle('can you explain quantum computing?')).toBe('Explain quantum computing')
    expect(localTitle('\n\n  第一行\n第二行')).toBe('第一行')
    expect(localTitle('帮我')).toBe('帮我')
    expect(localTitle('周末去哪里爬山比较好？我在杭州')).toBe('周末去哪里爬山比较好')
    expect(localTitle('Fix the login bug. It crashes on start')).toBe('Fix the login bug')
    expect(localTitle('好的？')).toBe('好的')
    expect(localTitle('一'.repeat(30))).toBe('一'.repeat(20) + '…')
  })

  it('attaches a folder only when every path the first turn touched is inside one known folder', () => {
    const known = ['/home/me/app', '/home/me/notes', 'C:\\Users\\me\\work']
    expect(folderOfTurn(reply('{"path":"/home/me/app/src/a.ts"}', 'cat /home/me/app/README.md'), known)).toBe('/home/me/app')
    expect(folderOfTurn(reply('{"path":"C:\\\\Users\\\\me\\\\work\\\\x.py"}'), known)).toBe('C:\\Users\\me\\work')
    expect(folderOfTurn(reply('{"path":"c:/users/me/work/y.py"}'), known)).toBe('C:\\Users\\me\\work')
    // Two folders, a path outside them all, or no paths: not clear, so nothing.
    expect(folderOfTurn(reply('/home/me/app/a', '/home/me/notes/b'), known)).toBeUndefined()
    expect(folderOfTurn(reply('/home/me/app/a', '/etc/hosts'), known)).toBeUndefined()
    expect(folderOfTurn(reply('ls'), known)).toBeUndefined()
    expect(folderOfTurn(reply('/home/me/apple/a'), known)).toBeUndefined()
    // Nested known folders: the outer one holds everything.
    expect(folderOfTurn(reply('/home/me/app/web/a', '/home/me/app/b'), [...known, '/home/me/app/web'])).toBe('/home/me/app')
  })
})
