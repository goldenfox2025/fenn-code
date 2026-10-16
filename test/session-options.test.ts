import { describe, expect, it } from 'vitest'
import type { SessionOption } from '../src/shared/contract'
import { visibleSessionOptions } from '../src/shared/sessionOptions'

const choices = ['none', 'low', 'high'].map((value) => ({ value, name: value }))
const effort: SessionOption = { id: 'effort', name: 'Reasoning', category: 'thought_level', choices, current: 'low' }

describe('shared session option policy', () => {
  it('preserves valid none choices unless the backend declares otherwise', () => {
    expect(visibleSessionOptions([effort])[0].choices).toEqual(choices)
    expect(visibleSessionOptions([effort], { hideNoneReasoning: true })[0].choices.map((c) => c.value)).toEqual(['low', 'high'])
    expect(effort.choices).toEqual(choices)
  })

  it('does not remove none from unrelated controls and hides singleton controls', () => {
    const mode = { ...effort, id: 'mode', category: 'mode' }
    expect(visibleSessionOptions([mode], { hideNoneReasoning: true })).toEqual([mode])
    expect(visibleSessionOptions([{ ...effort, choices: [choices[0]] }])).toEqual([])
    expect(visibleSessionOptions([{ ...effort, choices: choices.slice(0, 2) }], { hideNoneReasoning: true })).toEqual([])
  })
})
