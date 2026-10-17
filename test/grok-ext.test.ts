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

  it('ignores what it does not know', () => {
    expect(note({ sessionUpdate: 'background_tasks' })).toBeNull()
    expect(grokExt('_other/x', { sessionId: 's1', update: { sessionUpdate: 'retry_state' } })).toBeNull()
  })
})
