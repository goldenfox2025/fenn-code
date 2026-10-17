/**
 * Reads an agent CLI's own session log, read-only, to learn how full a
 * session's context is: when the agent sends no ACP usage_update (Grok), or
 * when an old conversation is reopened and nothing has been reported yet.
 * Each log is found by the ACP session id; nothing is guessed when it isn't there.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionContext } from '../../shared/contract'
import type { MessageUsage } from '../../shared/usage'

export type SessionLogKind = 'codex' | 'claude' | 'grok'

export type { SessionContext }

const TAIL = 512 * 1024

/** The last part of a file as lines (a partial first line is dropped). */
async function tailLines(path: string): Promise<string[]> {
  const f = await open(path, 'r')
  try {
    const { size } = await f.stat()
    const start = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - start)
    await f.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines.filter((l) => l.trim())
  } finally {
    await f.close()
  }
}

const parse = (line: string): any => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const safeId = (id: string) => /^[\w.-]+$/.test(id)

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** `<root>/<any folder>/<file>`: Claude Code's and Qoder's projects/<cwd slug>/<session>.jsonl. */
async function inAnyFolder(root: string, file: string): Promise<string | undefined> {
  for (const d of await dirs(root)) if (await exists(join(root, d, file))) return join(root, d, file)
  return undefined
}

/** Codex: sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl, newest days first. */
async function codexFile(home: string, id: string): Promise<string | undefined> {
  const root = join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions')
  const desc = (l: string[]) => l.sort().reverse()
  for (const y of desc(await dirs(root)))
    for (const m of desc(await dirs(join(root, y))))
      for (const d of desc(await dirs(join(root, y, m)))) {
        const day = join(root, y, m, d)
        // Usually rollout-<time>-<id>.jsonl; a few are rollout-<time>-<id>_<other id>.jsonl.
        const hit = (await readdir(day).catch(() => [] as string[])).find((f) => f.startsWith('rollout-') && f.endsWith('.jsonl') && new RegExp(`[-_]${id.replace(/\./g, '\\.')}[_.]`).test(f))
        if (hit) return join(day, hit)
      }
  return undefined
}

/** Codex: the last token_count event; `last_token_usage` is the latest request alone. */
export function codexContext(lines: string[]): SessionContext | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const x = parse(lines[i])
    if (x?.type !== 'event_msg' || x.payload?.type !== 'token_count' || !x.payload.info) continue
    const last = x.payload.info.last_token_usage ?? {}
    const used = n(last.total_tokens) ?? (n(last.input_tokens) !== undefined ? last.input_tokens + (n(last.output_tokens) ?? 0) : undefined)
    if (used === undefined) continue
    return { used, size: n(x.payload.info.model_context_window) }
  }
  return undefined
}

/**
 * Claude Code: the last main-thread assistant entry. Its input does
 * not include the cache, so the context is input plus cache reads and writes.
 */
export function claudeContext(lines: string[]): SessionContext | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const x = parse(lines[i])
    if (x?.type !== 'assistant' || x.isSidechain) continue
    // Placeholder replies Claude Code writes after an interruption or API error carry no real usage.
    if (x.message?.model === '<synthetic>') continue
    const u = x.message?.usage
    const input = n(u?.input_tokens)
    if (input === undefined) continue
    const used = input + (n(u.cache_read_input_tokens) ?? 0) + (n(u.cache_creation_input_tokens) ?? 0)
    if (!used) continue
    return { used, model: typeof x.message.model === 'string' ? x.message.model : undefined }
  }
  return undefined
}

/** The first object (depth-first, a few levels down) that passes `test`. */
function find(x: unknown, test: (o: Record<string, any>) => boolean, depth = 4): Record<string, any> | undefined {
  if (!x || typeof x !== 'object' || depth < 0) return undefined
  if (test(x as Record<string, any>)) return x as Record<string, any>
  for (const v of Object.values(x)) {
    const hit = find(v, test, depth - 1)
    if (hit) return hit
  }
  return undefined
}

/**
 * Grok: the last turn's turn_completed usage (none for a / command it answered
 * itself). Its input already counts cache reads and sums every model call of
 * the turn, so it is what the turn cost, not how full the context is; that is
 * the `_meta.totalTokens` its updates carry, the figure its own /session-info shows.
 * Its cost is in ticks of 1e-10 USD.
 */
export function grokContext(lines: string[]): SessionContext | undefined {
  let used: number | undefined
  for (let i = lines.length - 1; i >= 0 && used === undefined; i--) {
    if (!lines[i].includes('"totalTokens"')) continue
    const v = n(parse(lines[i])?.params?._meta?.totalTokens)
    if (v) used = v
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('turn_completed')) continue
    const x = parse(lines[i])
    const done = x?.params?.update
    if (done?.sessionUpdate !== 'turn_completed') continue
    const turnKey = typeof done.prompt_id === 'string' ? done.prompt_id : `${i}:${lines[i].length}`
    const u = find(x, (o) => typeof o.inputTokens === 'number' && typeof o.outputTokens === 'number')
    if (!u) return { used, turnKey }
    const input = n(u.inputTokens) ?? 0
    const cachedRead = n(u.cachedReadTokens)
    const ticks = n(u.costUsdTicks)
    const turn: MessageUsage = {
      input: Math.max(0, input - (cachedRead ?? 0)),
      output: n(u.outputTokens),
      thought: n(u.reasoningTokens),
      cachedRead,
      cachedWrite: n(u.cacheCreationTokens),
      cost: ticks !== undefined ? { amount: ticks / 1e10, currency: 'USD' } : undefined
    }
    for (const k of Object.keys(turn) as (keyof MessageUsage)[]) if (turn[k] === undefined) delete turn[k]
    turn.total = (turn.input ?? 0) + (turn.output ?? 0)
    const models = u.modelUsage && typeof u.modelUsage === 'object' ? Object.keys(u.modelUsage) : []
    // Without totalTokens (older Grok), one model call's input plus output is also what the context holds.
    used ??= (n(u.modelCalls) ?? 1) <= 1 ? input + (n(u.outputTokens) ?? 0) : undefined
    return { used, model: models.length === 1 ? models[0] : undefined, turn, turnKey }
  }
  return used !== undefined ? { used } : undefined
}

export async function readSessionContext(kind: SessionLogKind, sessionId: string, home = homedir()): Promise<SessionContext | undefined> {
  if (!safeId(sessionId)) return undefined
  try {
    if (kind === 'codex') {
      const f = await codexFile(home, sessionId)
      return f ? codexContext(await tailLines(f)) : undefined
    }
    if (kind === 'claude') {
      const root = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
      const f = await inAnyFolder(root, `${sessionId}.jsonl`)
      return f ? claudeContext(await tailLines(f)) : undefined
    }
    const root = join(home, '.grok', 'sessions')
    for (const d of await dirs(root)) {
      const f = join(root, d, sessionId, 'updates.jsonl')
      if (await exists(f)) return grokContext(await tailLines(f))
    }
  } catch {
    // An unreadable log is the same as none.
  }
  return undefined
}
