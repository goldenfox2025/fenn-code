import { describe, expect, it } from 'vitest'
import { currentPlan, isBookkeeping, planEntries, planWindow } from '../src/shared/plan'
import type { Message } from '../src/shared/model'

describe('the plan card', () => {
  const message = (id: string, role: Message['role'], createdAt: number, blocks: Message['blocks'] = [], extra: Partial<Message> = {}): Message => ({ id, role, createdAt, blocks, conversationId: 'chat', ...extra })
  it('retains a plan through assistant continuations but not across unrelated user turns', () => {
    const messages = [message('u1', 'user', 1), message('a1', 'assistant', 2, [{ type: 'plan', entries: [{ content: 'Fix parser', status: 'in_progress' }] }]), message('a2', 'assistant', 3)]
    expect(currentPlan({}, messages).entries[0].status).toBe('doing')
    messages.push(message('u2', 'user', 4))
    expect(currentPlan({}, messages).entries).toEqual([])
    expect(currentPlan({ checklist: '✱ Fix parser', checklistUpdatedAt: 2 }, messages).stale).toBe(true)
    expect(currentPlan({ checklist: '✓ Fix parser', checklistUpdatedAt: 2 }, messages).entries).toEqual([])
    expect(currentPlan({ checklist: '✱ New task', checklistUpdatedAt: 5 }, messages).stale).toBe(false)
  })

  it('ignores hidden housekeeping and automatic placeholder plans; an empty ACP plan withdraws the card', () => {
    const messages = [message('u', 'user', 1), message('a', 'assistant', 2, [{ type: 'plan', entries: [] }])]
    expect(currentPlan({ checklist: '✱ Old task' }, messages).entries).toEqual([])
    expect(currentPlan({ checklist: '✱ 正在处理', checklistAuto: true }, [messages[0]]).entries).toEqual([])
    const hidden = message('hidden', 'assistant', 3, [{ type: 'plan', entries: [{ content: 'Private title generation', status: 'in_progress' }] }], { hidden: true })
    expect(currentPlan({}, [...messages, hidden]).entries).toEqual([])
  })

  it('keeps the current step and nearby context visible in long plans', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ text: `Step ${i}`, status: i < 11 ? 'done' as const : i === 11 ? 'doing' as const : 'pending' as const }))
    const window = planWindow(entries)
    expect(window.entries.map(e => e.text)).toEqual(['Step 10', 'Step 11', 'Step 12', 'Step 13', 'Step 14', 'Step 15'])
    expect(window.before).toBe(10)
    expect(window.after).toBe(4)
    expect(planWindow(entries.slice(0, 3)).entries).toHaveLength(3)
    expect(planWindow([])).toEqual({ entries: [], before: 0, after: 0 })
  })

  it('uses the latest canonical update when update_status follows an ACP plan', () => {
    const messages = [message('u', 'user', 1), message('a', 'assistant', 3, [{ type: 'plan', entries: [{ content: 'Fix parser', status: 'in_progress' }] }])]
    expect(currentPlan({ checklist: '✓ Fix parser', checklistUpdatedAt: 4 }, messages).entries[0].status).toBe('done')
    expect(currentPlan({ checklist: '✓ Earlier task', checklistUpdatedAt: 2 }, messages).entries[0].status).toBe('doing')
    expect(currentPlan({ checklist: undefined, checklistUpdatedAt: 4 }, messages).entries).toEqual([])
    const internal = message('internal', 'assistant', 5, [{ type: 'plan', entries: [{ content: 'Internal task', status: 'in_progress' }] }], { housekeeping: true })
    expect(currentPlan({ checklist: '✓ Fix parser', checklistUpdatedAt: 4 }, [...messages, internal]).entries).toEqual([{ text: 'Fix parser', status: 'done' }])
  })
  it('reads the checklist the agent wrote, without the title or bold marks', () => {
    expect(planEntries({ checklist: '整理定价\n\n✓ **找到三家竞品**\n✱ 正在对比价格\n○ 写结论' })).toEqual([
      { text: '找到三家竞品', status: 'done' },
      { text: '正在对比价格', status: 'doing' },
      { text: '写结论', status: 'pending' }
    ])
  })

  it("takes the backend's ACP plan over the checklist while there is one", () => {
    const acp = [
      { content: 'Read the logs', status: 'completed' as const },
      { content: 'Fix the parser', status: 'in_progress' as const },
      { content: 'Run the tests', status: 'pending' as const }
    ]
    expect(planEntries({ checklist: '✓ 旧的一步', acp }).map((e) => e.status)).toEqual(['done', 'doing', 'pending'])
    expect(planEntries({ checklist: '✓ 旧的一步', acp: [] })).toEqual([{ text: '旧的一步', status: 'done' }])
  })

  it('keeps the rows the app adds after the agent replaces its plan', () => {
    const waiting = ['等「调研」完成后交接']
    const first = planEntries({ acp: [{ content: 'A', status: 'in_progress' }], waiting })
    const second = planEntries({ acp: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }], waiting })
    expect(first.at(-1)).toEqual({ text: '等「调研」完成后交接', status: 'waiting', app: true })
    expect(second.at(-1)).toEqual({ text: '等「调研」完成后交接', status: 'waiting', app: true })
  })

  it('drops steps that only narrate the interface', () => {
    expect(isBookkeeping('标记讨论串完成')).toBe(true)
    expect(planEntries({ checklist: '✓ 核对要求\n✓ 验证结果\n✱ 标记讨论串完成' }).map(entry => entry.status)).toEqual(['done','done'])
    for (const s of ['回复用户', '发出审批卡', '发决策卡给用户', '等你选择', '等待用户确认', 'Reply to the user', 'send the decision card', 'Wait for user input'])
      expect(isBookkeeping(s), s).toBe(true)
    for (const s of ['查清原因', '改代码并测试', '出报告', '回复邮件里的三个问题整理成表', '验证审批卡共存', '修复决策卡键盘操作', 'Reply parser rewrite'])
      expect(isBookkeeping(s), s).toBe(false)
    expect(planEntries({ checklist: '✓ 查清原因\n✱ 发出审批卡\n○ 等你选择' })).toEqual([{ text: '查清原因', status: 'done' }])
  })
})
