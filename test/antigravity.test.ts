import { describe, expect, it } from 'vitest'
import agy from '../src/main/backends/plugins/antigravity'

describe('Antigravity', () => {
  it('reads its sign-in state from its settings and files, and is offered only to install', async () => {
    const bin = process.execPath
    expect(await agy.account!({ AGY_ACP_BIN: bin, GEMINI_API_KEY: 'x' })).toMatchObject({ installed: true, signedIn: true })
    expect(await agy.account!({ AGY_ACP_BIN: '/nonexistent/agy' })).toMatchObject({})
    expect(agy.upgrade?.installOnly ?? true).toBe(true)
  })
})
