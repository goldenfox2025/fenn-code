import { describe, expect, it } from 'vitest'
import { grokExt } from '../src/main/backends/plugins/grok'

const note = (update: Record<string, unknown>) => grokExt('_x.ai/session_notification', { sessionId: 's1', update })

describe('Grok vendor notifications', () => {
  it('shows /goal progress in the plan card', () => {
    const r = note({ sessionUpdate: 'goal_updated', objective: '测试一下。', status: 'active', planning: true, total_deliverables: 0 })
    expect(r?.events).toEqual([
      { kind: 'plan', entries: [{ content: '目标：测试一下。', status: 'in_progress' }, { content: '正在拟定计划', status: 'in_progress' }] }
    ])
    const paused = note({ sessionUpdate: 'goal_updated', objective: '测试一下。', status: 'user_paused', total_deliverables: 3, completed_deliverables: 1 })
    expect(paused?.events[0]).toEqual({
      kind: 'plan',
      entries: [{ content: '目标（已暂停）：测试一下。', status: 'pending' }, { content: '交付物 1/3', status: 'pending' }]
    })
  })

  it('shows a subagent as one step', () => {
    const id = '01a14989-8331'
    expect(note({ sessionUpdate: 'subagent_spawned', subagent_id: id, description: 'goal plan writer' })?.events[0]).toMatchObject({
      kind: 'tool.start',
      toolId: `grok-subagent:${id}`,
      title: '子任务：goal plan writer',
      status: 'running'
    })
    expect(note({ sessionUpdate: 'subagent_finished', subagent_id: id, status: 'completed', output: 'Done' })?.events[0]).toEqual({
      kind: 'tool.update',
      toolId: `grok-subagent:${id}`,
      status: 'completed',
      output: 'Done'
    })
  })

  it('shows auto-compaction as a step and the smaller context', () => {
    const start = note({ sessionUpdate: 'auto_compact_started' })!.events[0] as { toolId: string }
    const done = note({ sessionUpdate: 'auto_compact_completed', tokens_before: 410000, tokens_after: 52000 })!.events
    expect(done).toEqual([
      { kind: 'tool.update', toolId: start.toolId, status: 'completed', output: '410,000 → 52,000 tokens' },
      { kind: 'compacted' },
      { kind: 'usage', contextUsed: 52000 }
    ])
  })

  it('says it is retrying only while it retries; a hard failure adds no notice', () => {
    const retrying = note({ sessionUpdate: 'retry_state', type: 'retrying', attempt: 2, max_retries: 15, reason: 'API error (status 503)' })
    expect(retrying?.events).toEqual([{ kind: 'notice', level: 'warning', key: 'grok-retry', text: '连接 Grok 失败，正在重试（2/15）' }])
    // What Grok sends on a 400, a bad key or model: no numbers, the reason in "message"; the error bar covers it.
    expect(note({ sessionUpdate: 'retry_state', type: 'failed', error_type: 'api', message: 'API error (status 400 Bad Request)' })).toBeNull()
    expect(note({ sessionUpdate: 'retry_state', type: 'retrying' })).toBeNull()
  })

  it('ignores what it does not know', () => {
    expect(note({ sessionUpdate: 'background_tasks' })).toBeNull()
    expect(grokExt('_other/x', { sessionId: 's1', update: { sessionUpdate: 'retry_state' } })).toBeNull()
  })
})

describe('Grok background tasks', () => {
  it('lists its background commands and monitors, which Grok runs and stops itself', () => {
    const started = note({ sessionUpdate: 'task_backgrounded', task_id: 'call-1', command: 'python run.py', description: 'Run the collector' })
    expect(started?.events[0]).toEqual({
      kind: 'background',
      id: 'grok-task:call-1',
      command: 'python run.py',
      state: 'running',
      exitCode: null,
      title: 'Run the collector',
      managed: true,
      monitor: undefined
    })
    const done = note({ sessionUpdate: 'task_completed', task_snapshot: { task_id: 'call-1', command: 'python run.py', exit_code: 1, completed: true } })
    expect(done?.events[0]).toMatchObject({ id: 'grok-task:call-1', state: 'exited', exitCode: 1 })
    const list = note({
      sessionUpdate: 'background_tasks',
      tasks: [
        { task_id: 'm-1', command: 'powershell watch.ps1', display_command: '[monitor] Wait for the tick', kind: 'monitor', status: 'running' },
        { task_id: 'call-2', command: 'ping', kind: 'bash', status: 'completed', exit_code: 0 }
      ]
    })
    expect(list?.events).toMatchObject([
      { id: 'grok-task:m-1', command: '[monitor] Wait for the tick', state: 'running', monitor: true },
      { id: 'grok-task:call-2', state: 'exited', exitCode: 0 }
    ])
  })
})
