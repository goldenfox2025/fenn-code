import { describe, expect, it } from 'vitest'
import { normalizeTheme } from '../src/shared/model'

describe('appearance settings', () => {
  it('reads the old glass theme as dark with the glass switch on', () => {
    expect(normalizeTheme({ theme: 'glass' })).toEqual({ theme: 'dark', glass: true })
  })
  it('leaves a color scheme and the glass switch independent', () => {
    expect(normalizeTheme({ theme: 'light', glass: true })).toEqual({ theme: 'light', glass: true })
    expect(normalizeTheme({ theme: 'system' })).toEqual({ theme: 'system' })
  })
})
