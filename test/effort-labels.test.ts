import { describe, expect, it, vi } from 'vitest'

describe('thinking level labels in the Chinese UI', () => {
  it('read by value first and never show raw English', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'zh', setItem() {}, removeItem() {} })
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    vi.stubGlobal('document', { documentElement: {} })
    const { choiceLabel, effortLabel } = await import('../src/renderer/src/components/sessionOptionLabels')
    const { recommendedEffort } = await import('../src/renderer/src/components/EffortPicker')
    // A value the table knows wins over an odd display name.
    expect(choiceLabel('Think a lot', 'high')).toBe('高')
    expect(choiceLabel('Extra-High effort')).toBe('很高')
    const o = {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      current: 'medium',
      choices: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'turbo-9', name: 'Turbo Nine' },
        { value: 'x', name: '超深' }
      ]
    } as any
    expect(o.choices.map((_: unknown, i: number) => effortLabel(o, i))).toEqual(['低', '中', '第 3 档', '超深'])
    expect(recommendedEffort(o)).toBe(1)
    vi.unstubAllGlobals()
  })
})
