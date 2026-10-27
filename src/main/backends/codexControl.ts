import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { windowsSafe } from './acp/AcpBackend'
import { endTree } from './workspace'

/** Small local app-server requests for metadata; never reads or edits Codex's database files. */
export function codexThreadRequest(program: string, method: string, params: Record<string, unknown>): Promise<void> {
  return codexMetadataRequest(program, method, params).then(() => undefined)
}
/** Read metadata through the supported local app-server transport. */
export function codexMetadataRequest(program: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const spec = windowsSafe(program, ['app-server'])
  return new Promise((resolve, reject) => {
    const proc = spawn(spec.command, spec.args, { shell: spec.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); lines.close()
      proc.stdin.end(); endTree(proc)
      error ? reject(error) : resolve(result)
    }
    const send = (message: unknown) => proc.stdin.write(JSON.stringify(message) + '\n')
    const lines = createInterface({ input: proc.stdout })
    const timer = setTimeout(() => finish(new Error('Codex metadata request timed out')), 15_000)
    proc.stderr.on('data', () => {})
    proc.on('error', finish)
    proc.stdin.on('error', finish)
    proc.on('exit', (code) => { if (!settled) finish(new Error(`Codex metadata process exited (${code})`)) })
    lines.on('line', (line) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } }
      try { message = JSON.parse(line) } catch { return }
      if (message.id === 0) {
        if (message.error) return finish(new Error(message.error.message || 'Codex initialization failed'))
        send({ method: 'initialized', params: {} }); send({ id: 1, method, params })
      } else if (message.id === 1) finish(message.error ? new Error(message.error.message || 'Codex metadata request failed') : undefined, message.result)
    })
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'fenn_code', title: 'Fenn Code', version: '0.1.3' } } })
  })
}

/** Text-only housekeeping uses Codex's native no-history mode, never an archived ACP thread. */
export function codexEphemeral(program: string, text: string, opts: { cwd: string; timeoutMs?: number; model?: string }): Promise<string> {
  const args = ['--ask-for-approval', 'never', 'exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', ...(opts.model ? ['--model', opts.model] : []), '-']
  const spec = windowsSafe(program, args)
  return new Promise((resolve, reject) => {
    const proc = spawn(spec.command, spec.args, { shell: spec.shell, cwd: opts.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let answer = '', detail = '', settled = false, failed = false
    const lines = createInterface({ input: proc.stdout })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; clearTimeout(timer); lines.close()
      if (error) { endTree(proc); reject(error) } else resolve(answer.trim())
    }
    const timer = setTimeout(() => finish(new Error('Codex background request timed out')), opts.timeoutMs ?? 60_000)
    proc.on('error', finish)
    proc.stdin.on('error', finish)
    proc.stderr.on('data', (chunk) => { detail = (detail + chunk.toString()).slice(-2000) })
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.type === 'item.completed' && message.item?.type === 'agent_message' && typeof message.item.text === 'string') answer = message.item.text
        if (message.type === 'turn.failed') { failed = true; detail = message.error?.message || 'Codex background request failed' }
      } catch { /* Ignore non-JSON diagnostics; never expose them as a model answer. */ }
    })
    proc.on('exit', (code) => finish(code === 0 && answer && !failed ? undefined : new Error(detail || `Codex background request failed (${code})`)))
    proc.stdin.end('This is a text-only internal helper request. Use only the supplied text; do not run tools or inspect files.\n\n' + text)
  })
}
