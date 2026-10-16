import { createCipheriv } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptMacV10, macKeyFromPassword, repairSecrets, type Codec } from '../src/main/store/secrets'
import { Store } from '../src/main/store/Store'

/** What Electron's safeStorage wrote on macOS under the old name. */
function oldMacSeal(plain: string, password: string): string {
  const c = createCipheriv('aes-128-cbc', macKeyFromPassword(password), Buffer.alloc(16, ' '))
  return 'enc:' + Buffer.concat([Buffer.from('v10'), c.update(plain, 'utf8'), c.final()]).toString('base64')
}

/** The new app's own key: values it sealed start with "enc:new:". */
const codec: Codec = {
  open: (v) => {
    if (!v.startsWith('enc:new:')) throw new Error('bad key')
    return v.slice(8)
  },
  seal: (p) => 'enc:new:' + p
}

function store() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'sec-')))
  s.setBackendSetting('qoder', 'QODER_PERSONAL_ACCESS_TOKEN', oldMacSeal('tok-123', 'old-pw'))
  s.setBackendSetting('qoder', 'MODEL', 'plain')
  s.setBackendSetting('grok', 'XAI_API_KEY', 'enc:new:already-fine')
  s.putConnector({ id: 'c1', name: 'github', enabled: true, kind: 'http', url: 'https://x', secrets: { Authorization: oldMacSeal('Bearer z', 'old-pw') } })
  return s
}
const label = (id: string, k: string) => `${id}/${k}`

describe('secrets saved before the rename', () => {
  it('decrypts the macOS v10 format', () => {
    const v = oldMacSeal('你好 token', 'pw')
    expect(decryptMacV10(Buffer.from(v.slice(4), 'base64'), macKeyFromPassword('pw'))).toBe('你好 token')
  })

  it('re-encrypts what the old key opens, and leaves good values alone', () => {
    const s = store()
    const lost = repairSecrets(s, codec, label, () => [macKeyFromPassword('cove-pw'), macKeyFromPassword('old-pw')])
    expect(lost).toEqual([])
    expect(s.backendSettings('qoder')).toEqual({ QODER_PERSONAL_ACCESS_TOKEN: 'enc:new:tok-123', MODEL: 'plain' })
    expect(s.backendSettings('grok')).toEqual({ XAI_API_KEY: 'enc:new:already-fine' })
    expect(s.connectors[0].secrets).toEqual({ Authorization: 'enc:new:Bearer z' })
  })

  it('removes only what neither key opens, asking for the old key only once', () => {
    const s = store()
    let asked = 0
    const lost = repairSecrets(s, codec, label, () => (asked++, [macKeyFromPassword('a'), macKeyFromPassword('b')]))
    expect(asked).toBe(1)
    expect(lost).toEqual(['qoder/QODER_PERSONAL_ACCESS_TOKEN', '连接器「github」的 Authorization'])
    expect(s.backendSettings('qoder')).toEqual({ MODEL: 'plain' })
    expect(s.backendSettings('grok')).toEqual({ XAI_API_KEY: 'enc:new:already-fine' })
    expect(s.connectors[0].secrets).toEqual({})
  })

  it('keeps values while one old name\'s key is out of reach', () => {
    const s = store()
    expect(repairSecrets(s, codec, label, () => [macKeyFromPassword('cove-pw')])).toHaveLength(2)
    expect(s.backendSettings('qoder').QODER_PERSONAL_ACCESS_TOKEN).toMatch(/^enc:/)
    expect(s.connectors[0].secrets?.Authorization).toMatch(/^enc:/)
  })

  it('keeps values it cannot judge when the old key is out of reach', () => {
    const s = store()
    const before = s.backendSettings('qoder').QODER_PERSONAL_ACCESS_TOKEN
    const lost = repairSecrets(s, codec, label, () => [])
    expect(lost).toEqual(['qoder/QODER_PERSONAL_ACCESS_TOKEN', '连接器「github」的 Authorization'])
    expect(s.backendSettings('qoder').QODER_PERSONAL_ACCESS_TOKEN).toBe(before)
    expect(s.connectors[0].secrets?.Authorization).toMatch(/^enc:/)
    // Once the keychain answers, a later run still recovers them.
    expect(repairSecrets(s, codec, label, () => [macKeyFromPassword('cove-pw'), macKeyFromPassword('old-pw')])).toEqual([])
    expect(s.backendSettings('qoder').QODER_PERSONAL_ACCESS_TOKEN).toBe('enc:new:tok-123')
  })
})
