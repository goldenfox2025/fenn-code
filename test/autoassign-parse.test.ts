import { describe, expect, it } from 'vitest'
import { folderOfTurn, parseAnswer } from '../src/main/core/AutoAssigner'

const reply = (...inputs: string[]) =>
  ({ blocks: inputs.map((input, i) => ({ type: 'tool', toolId: String(i), title: 'Read', status: 'completed', input })) }) as any

describe('tidying a new chat', () => {
  it('reads the title from the answer, among other text', () => {
    expect(parseAnswer('好的 {"title":"番茄种植"}。理由：{涉及种植}').title).toBe('番茄种植')
    expect(parseAnswer('随便聊聊').title).toBeUndefined()
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
