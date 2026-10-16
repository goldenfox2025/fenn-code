import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { CreditQuota } from '../../shared/contract'
import { windowsSafe } from './acp/AcpBackend'
import { qoderCommand } from './qoderCommand'

const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** Qoder SDK get_usage_info account buckets. Ignore its separate helper-session total. */
export function qoderQuota(response: unknown): CreditQuota | undefined {
  const usage = (response as { usage?: Record<string, any> } | null)?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const buckets: CreditQuota['buckets'] = []
  for (const [key, name] of [['userQuota', 'Plan'], ['addOnQuota', 'Add-on'], ['orgResourcePackage', 'Organization']]) {
    const bucket = usage[key]
    if (!bucket || typeof bucket !== 'object') continue
    const used = number(bucket.used)
    const total = number(key === 'orgResourcePackage' ? bucket.cap : bucket.total)
    const remaining = number(bucket.remaining)
    if (used === undefined && total === undefined && remaining === undefined) continue
    // Preserve units supplied by the service; a missing unit is not proof of Credits.
    if (typeof bucket.unit !== 'string' || !/^credits?$/i.test(bucket.unit.trim())) continue
    buckets.push({ name, used, total, remaining, unit: 'credits' })
  }
  return buckets.length ? { buckets, at: Date.now() } : undefined
}

/** Native SDK control requests only: no user message, inference or permission grants. */
export function readQoderCredits(config: Record<string, string>, timeoutMs = 20_000): Promise<CreditQuota | undefined> {
  // The CLI requires the same private auth payload used by qodercliAuth() /
  // accessToken() in the official SDK. Never send credentials through argv.
  const authDir = mkdtempSync(join(tmpdir(), 'ancora-qoder-usage-'))
  const authFile = join(authDir, 'payload.json')
  const token = config.QODER_PERSONAL_ACCESS_TOKEN || process.env.QODER_PERSONAL_ACCESS_TOKEN
  try {
    writeFileSync(authFile, JSON.stringify(token ? { type: 'accessToken', accessToken: token } : { type: 'qodercli' }), { mode: 0o600 })
  } catch {
    void unlink(authFile).catch(() => {}).then(() => rmdir(authDir).catch(() => {}))
    return Promise.resolve(undefined)
  }
  const spec = qoderCommand(config, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--no-session-persistence', '--tools', '', '--setting-sources', ''])
  const safe = windowsSafe(spec.command, spec.args)
  return new Promise((resolve) => {
    const proc = spawn(safe.command, safe.args, { shell: safe.shell, windowsHide: true, cwd: tmpdir(),
      env: { ...process.env, QODER_AGENT_SDK_ENTRYPOINT: 'ancora-usage', QODER_SDK_AUTH_PAYLOAD_FILE: authFile,
        ...(config.QODER_PERSONAL_ACCESS_TOKEN ? { QODER_PERSONAL_ACCESS_TOKEN: config.QODER_PERSONAL_ACCESS_TOKEN } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'] })
    let done = false
    const finish = (value?: CreditQuota) => {
      if (done) return
      done = true
      clearTimeout(timer)
      lines.close()
      proc.stdin.end()
      proc.kill()
      void unlink(authFile).catch(() => {}).then(() => rmdir(authDir).catch(() => {})).then(() => resolve(value))
    }
    const send = (request_id: string, subtype: string) => proc.stdin.write(JSON.stringify({ type: 'control_request', request_id, request: { subtype } }) + '\n')
    const timer = setTimeout(() => finish(), timeoutMs)
    const lines = createInterface({ input: proc.stdout })
    proc.stderr.resume() // Do not relay CLI startup logs or account details into the renderer.
    proc.on('error', () => finish())
    proc.on('exit', () => finish())
    proc.stdin.on('error', () => finish())
    lines.on('line', (line) => {
      if (done || line.length > 2_000_000) return
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.type !== 'control_response') return
      const response = message.response
      if (response?.subtype !== 'success') return finish()
      if (response.request_id === 'ancora-init') send('ancora-quota', 'get_usage_info')
      else if (response.request_id === 'ancora-quota') finish(qoderQuota(response.response))
    })
    send('ancora-init', 'initialize')
  })
}
