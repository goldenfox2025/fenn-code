import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qoderQuota, readQoderCredits } from '../src/main/backends/qoderCredits'

describe('Qoder account Credits', () => {
  it('keeps account buckets separate and ignores the helper session total', () => {
    const quota = qoderQuota({ usage: { userQuota: { used: 12.5, total: 100, remaining: 87.5, unit: 'credits' },
      addOnQuota: { used: 0, total: 50, remaining: 50, unit: 'Credits' },
      orgResourcePackage: { used: 3, cap: 10, remaining: 7, unit: 'credit' } }, session: { total_credits: 999 } })!
    expect(quota.buckets).toEqual([
      { name: 'Plan', used: 12.5, total: 100, remaining: 87.5, unit: 'credits' },
      { name: 'Add-on', used: 0, total: 50, remaining: 50, unit: 'credits' },
      { name: 'Organization', used: 3, total: 10, remaining: 7, unit: 'credits' }
    ])
    expect(qoderQuota({ session: { total_credits: 0 } })).toBeUndefined()
    expect(qoderQuota({ usage: { userQuota: { used: -1, total: '500', unit: 'credits' } } })).toBeUndefined()
    expect(qoderQuota({ usage: { userQuota: { used: 1, total: 10, unit: 'requests' } } })).toBeUndefined()
    expect(qoderQuota({ usage: { userQuota: { used: 1, total: 10, unit: 'notcredits' } } })).toBeUndefined()
    expect(qoderQuota(null)).toBeUndefined()
  })

  it('sends only SDK control requests and reads real quota fields without generating a prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ancora credits '))
    const entry = join(dir, 'qoder fixture.mjs')
    const capture = join(dir, 'requests.jsonl')
    const authPath = join(dir, 'auth-path.txt')
    writeFileSync(entry, `
      import { createInterface } from 'node:readline';
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      if (process.env.QODER_AGENT_SDK_ENTRYPOINT !== 'ancora-usage') process.exit(8);
      const auth = JSON.parse(readFileSync(process.env.QODER_SDK_AUTH_PAYLOAD_FILE, 'utf8'));
      if (auth.type !== 'accessToken' || auth.accessToken !== 'test-only-token') process.exit(7);
      writeFileSync(${JSON.stringify(authPath)}, process.env.QODER_SDK_AUTH_PAYLOAD_FILE);
      createInterface({ input: process.stdin }).on('line', line => {
        appendFileSync(${JSON.stringify(capture)}, line + '\\n');
        const m = JSON.parse(line);
        if (m.type !== 'control_request') process.exit(9);
        const value = m.request.subtype === 'get_usage_info'
          ? { usage: { userQuota: { used: 7.25, total: 500, remaining: 492.75, unit: 'credits' } }, session: { total_credits: 999 } } : {};
        console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: value } }));
      });
    `)
    try {
      const quota = await readQoderCredits({ QODER_NODE_PATH: process.execPath, QODER_CLI_PATH: entry, QODER_PERSONAL_ACCESS_TOKEN: 'test-only-token' })
      expect(quota?.buckets[0]).toMatchObject({ used: 7.25, total: 500, remaining: 492.75 })
      expect(readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line).request.subtype)).toEqual(['initialize', 'get_usage_info'])
      expect(existsSync(readFileSync(authPath, 'utf8'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
  })

  it('returns unavailable for an unsupported or missing CLI instead of inventing zero Credits', async () => {
    expect(await readQoderCredits({ QODER_CLI_PATH: 'ancora-missing-qoder-cli' }, 1000)).toBeUndefined()
  })

  it.skipIf(process.env.ANCORA_QODER_USAGE_PROBE !== '1')('performs a read-only control handshake with the installed Qoder CLI', async () => {
    const quota = await readQoderCredits({}, 15_000)
    console.log('Native Qoder account quota available:', !!quota)
    if (quota) expect(quota.buckets.every((b) => b.unit === 'credits')).toBe(true)
  })
})
