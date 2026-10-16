import { describe, expect, it } from 'vitest'
import { backendAvailable } from '../src/shared/backendAvailability'
import type { BackendSummary } from '../src/shared/contract'

const backend = (overrides: Partial<BackendSummary> = {}): BackendSummary => ({
  id: 'agent', name: 'Agent', settings: [], configured: {}, account: true, installed: true, ...overrides
})

describe('backend choices', () => {
  it('excludes missing programs before an account check has completed', () => {
    expect(backendAvailable(backend({ installed: false }))).toBe(false)
    expect(backendAvailable(backend({ installed: undefined }))).toBe(false)
  })
  it('excludes known sign-out or missing-program results even with an installed summary', () => {
    expect(backendAvailable(backend(), { signedIn: false })).toBe(false)
    expect(backendAvailable(backend(), { installed: false })).toBe(false)
  })
  it('accepts an installed program when status is unknown, without inventing sign-in success', () => {
    expect(backendAvailable(backend(), {})).toBe(true)
    expect(backendAvailable(backend({ installed: false }), { installed: true, signedIn: true })).toBe(true)
  })
  it('allows extensions without account probes and excludes explicitly missing extensions', () => {
    expect(backendAvailable(backend({ account: false, installed: undefined }))).toBe(true)
    expect(backendAvailable(backend({ account: false, installed: false }))).toBe(false)
  })
})
