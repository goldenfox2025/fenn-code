import { describe, expect, it } from 'vitest'
import { isBookkeeping, planEntries } from '../src/shared/plan'

describe('the plan card', () => {
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
    for (const s of ['回复用户', '发出审批卡', '发决策卡给用户', '等你选择', '等待用户确认', 'Reply to the user', 'send the decision card', 'Wait for user input'])
      expect(isBookkeeping(s), s).toBe(true)
    for (const s of ['查清原因', '改代码并测试', '出报告', '回复邮件里的三个问题整理成表', 'Reply parser rewrite'])
      expect(isBookkeeping(s), s).toBe(false)
    expect(planEntries({ checklist: '✓ 查清原因\n✱ 发出审批卡\n○ 等你选择' })).toEqual([{ text: '查清原因', status: 'done' }])
  })
})
