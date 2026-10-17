import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'
import { stalePlan } from '../src/main/core/ChatService'

const chat = (over: Partial<Conversation>): Conversation =>
  ({ id: 'c', kind: 'chat', title: 'T', backendId: 'grok', status: 'idle', createdAt: 0, updatedAt: 0, ...over }) as Conversation

describe('a chat plan that no longer applies', () => {
  it('goes once every step is done and the user writes again', () => {
    expect(stalePlan(chat({ checklist: 'T\n\n✓ a\n**✓ b**' }))).toBe(true)
    expect(stalePlan(chat({ checklist: 'T\n\n✓ a\n✱ b' }))).toBe(false)
  })

  it('goes when the chat has moved to another agent', () => {
    expect(stalePlan(chat({ checklist: 'T\n\n✱ a', sessionRef: { backendId: 'codex', sessionId: 's' } }))).toBe(true)
    expect(stalePlan(chat({ checklist: 'T\n\n✱ a', sessionRef: { backendId: 'grok', sessionId: 's' } }))).toBe(false)
  })

  it('stays on a thread, where it is the status on the board', () => {
    expect(stalePlan(chat({ kind: 'thread', checklist: 'T\n\n✓ a' }))).toBe(false)
  })
})
