/**
 * Secrets saved before the app was renamed (openclaude → Cove → Ancora → Fenn Code).
 *
 * Electron encrypts secrets with a key kept by the OS under the app's name.
 * On Windows that key lives in the data folder and moved with it. On macOS it
 * sits in the keychain as "<old name> Safe Storage", so Fenn Code can't decrypt the
 * old values with its own key; they are decrypted with an old key and saved
 * again. A value is removed only when both keys provably fail to open it;
 * when the old key can't be read (Linux keyrings, or the user refuses keychain
 * access) the value is kept, since it may still open later, and the user is
 * told which ones to fill in again.
 *
 * This runs once, and only while the OS keychain is usable: a keychain that is
 * locked or missing at launch must never cost the user their secrets.
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Store } from './Store'
import { t } from '../../shared/i18n'

export interface Codec {
  /** Decrypts an "enc:…" value; throws when it can't. */
  open(sealed: string): string
  seal(plain: string): string
}

/** Chromium's macOS scheme: "v10" + AES-128-CBC, key from PBKDF2 of the keychain password. */
export function macKeyFromPassword(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

export function decryptMacV10(data: Buffer, key: Buffer): string {
  if (data.subarray(0, 3).toString() !== 'v10') throw new Error('not v10')
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([d.update(data.subarray(3)), d.final()]).toString('utf8')
}

/** An old name's key from the macOS keychain (macOS may ask the user to allow this once). */
export function legacyMacKey(oldName: string): Buffer | undefined {
  try {
    const pw = execFileSync('security', ['find-generic-password', '-w', '-s', `${oldName} Safe Storage`], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return pw ? macKeyFromPassword(pw) : undefined
  } catch {
    return undefined
  }
}

/** Names the app had before, newest first; their keychain keys may hold old secrets. */
export const OLD_NAMES = ['Ancora', 'Cove', 'openclaude']

/**
 * Re-encrypts what the old key can open, and drops what neither key opens.
 * Returns readable names of the secrets the user has to enter again.
 */
export function repairSecrets(
  store: Store,
  codec: Codec,
  label: (backendId: string, key: string) => string,
  legacyKeys: () => Buffer[]
): string[] {
  let keys: Buffer[] | null = null
  /** The value to keep, null to drop it; `lost` when the user has to enter it again. */
  const recover = (v: string): { value: string | null; lost: boolean } => {
    try {
      codec.open(v)
      return { value: v, lost: false }
    } catch {
      /* fall through */
    }
    if (keys === null) keys = legacyKeys()
    if (!keys.length) return { value: v, lost: true }
    for (const key of keys) {
      try {
        return { value: codec.seal(decryptMacV10(Buffer.from(v.slice(4), 'base64'), key)), lost: false }
      } catch {
        /* try the next old key */
      }
    }
    // Only dropped when every old name's key was read and none opens it.
    return { value: keys.length === OLD_NAMES.length ? null : v, lost: true }
  }
  const lost: string[] = []
  for (const [id, values] of Object.entries(store.allBackendSettings())) {
    for (const [k, v] of Object.entries(values)) {
      if (!v.startsWith('enc:')) continue
      const r = recover(v)
      if (r.value !== v) store.setBackendSetting(id, k, r.value ?? '')
      if (r.lost) lost.push(label(id, k))
    }
  }
  for (const c of store.connectors) {
    let changed = false
    const secrets = { ...(c.secrets ?? {}) }
    for (const [k, v] of Object.entries(secrets)) {
      if (!v.startsWith('enc:')) continue
      const r = recover(v)
      if (r.lost) lost.push(t('连接器「{0}」的 {1}', c.name, k))
      if (r.value === v) continue
      changed = true
      if (r.value === null) delete secrets[k]
      else secrets[k] = r.value
    }
    if (changed) store.putConnector({ ...c, secrets })
  }
  return lost
}
