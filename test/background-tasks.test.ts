import { describe, expect, it } from 'vitest'
import { backgroundTasks, canStopTask, taskIsFinished } from '../src/shared/backgroundTasks'
import type { BackgroundCommand, Conversation } from '../src/shared/model'

const conversation = (id: string, extra: Partial<Conversation> = {}): Conversation => ({ id, kind: 'chat', title: id, backendId: 'mock', status: 'idle', createdAt: 1, updatedAt: 2, ...extra })
const command = (extra: Partial<BackgroundCommand> = {}): BackgroundCommand => ({ id: 'command', command: 'test', startedAt: 1, ...extra })

describe('background task scope and states', () => {
  it('keeps parent/child commands distinct and derives the running badge from the visible scope', () => {
    const root = conversation('root', { background: [command()] })
    const child = conversation('child', { parentId: root.id, status: 'working', background: [command()] })
    const sibling = conversation('sibling', { parentId: root.id, status: 'done' })
    const unrelated = conversation('other', { status: 'working', background: [command()] })
    const tasks = backgroundTasks(child, [root, child, sibling, unrelated])
    expect(tasks.filter(task => task.state === 'running')).toHaveLength(3)
    expect(tasks.filter(task => task.kind === 'command').map(task => task.ownerId).sort()).toEqual(['child', 'root'])
    expect(new Set(tasks.map(task => task.key)).size).toBe(tasks.length)
    expect(backgroundTasks(root, [root, child, sibling, unrelated]).filter(task => task.kind === 'command')).toHaveLength(1)
  })
  it('does not turn idle, unknown termination or failure into a successful completion', () => {
    const root = conversation('root', { background: [command({ endedAt: 2, failed: true }), command({ id: 'unknown', endedAt: 2 }), command({ id: 'ok', endedAt: 2, exitCode: 0 }), command({ id: 'nonzero', endedAt: 2, exitCode: 1 })] })
    const tasks = backgroundTasks(root, [root, conversation('child', { parentId: root.id })])
    expect(tasks.filter(task => task.state === 'failed')).toHaveLength(2)
    expect(tasks.filter(taskIsFinished).map(task => task.state).sort()).toEqual(['done', 'ended', 'failed', 'failed', 'idle'])
    expect(tasks[0].state).toBe('failed')
  })
  it('shows attention states and only exposes controls the backend supports', () => {
    const root = conversation('root', { background: [command({ managed: true }), command({ id: 'owned' })] })
    const tasks = backgroundTasks(root, [root, conversation('needs-user', { parentId: root.id, status: 'waiting' }), conversation('running', { parentId: root.id, status: 'working' })])
    expect(tasks[0].state).toBe('waiting')
    expect(tasks.filter(canStopTask).map(task => task.ownerId).sort()).toEqual(['root', 'running'])
  })
  it('retains a child command when its parent was removed', () => {
    const child = conversation('child', { parentId: 'gone', background: [command()] })
    expect(backgroundTasks(child, [child]).filter(task => task.kind === 'command')).toHaveLength(1)
  })
})
