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

  it('run from fastest to smartest whatever order the agent lists them in', async () => {
    const { effortStops } = await import('../src/renderer/src/components/sessionOptionLabels')
    const { recommendedEffort } = await import('../src/renderer/src/components/EffortPicker')
    const c = (value: string, name = value) => ({ value, name })
    const order = (list: { value: string; name: string }[]) => effortStops(list).map((x) => x.value)
    const codex = [c('xhigh', 'Extra High'), c('high', 'High'), c('medium', 'Medium'), c('low', 'Low')]
    expect(order(codex)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(order([c('high'), c('minimal'), c('max'), c('low'), c('medium')])).toEqual(['minimal', 'low', 'medium', 'high', 'max'])
    expect(recommendedEffort({ choices: codex } as any)).toBe(1)
    // Names alone are enough; unknown ids are read from them.
    expect(order([c('e3', 'Very High'), c('e1', 'Low'), c('e2', 'Medium')])).toEqual(['e1', 'e2', 'e3'])
    // Mostly unknown: the agent's order, turned around when the known ones run high to low.
    expect(order([c('turbo'), c('high'), c('zz'), c('low')])).toEqual(['low', 'zz', 'high', 'turbo'])
    expect(order([c('a'), c('b'), c('c')])).toEqual(['a', 'b', 'c'])
  })
})
