/**
 * Reads an agent CLI's own session log, read-only, to learn how full a
 * session's context is: when the agent sends no ACP usage_update (Grok, Qoder), or
 * when an old conversation is reopened and nothing has been reported yet.
 * Each log is found by the ACP session id; nothing is guessed when it isn't there.
 */
import { open, readdir, readFile, stat } from 'node:fs/promises'
import * as zlib from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionContext } from '../../shared/contract'
import type { MessageUsage } from '../../shared/usage'

export type SessionLogKind = 'codex' | 'claude' | 'qoder' | 'grok' | 'antigravity'

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

const codexHome = (home: string) => process.env.CODEX_HOME || join(home, '.codex')

/** Usually rollout-<time>-<id>.jsonl; a few are rollout-<time>-<id>_<other id>.jsonl; a cold one is compressed (.jsonl.zst). */
function rolloutOf(files: string[], id: string): string | undefined {
  const named = new RegExp(`[-_]${id.replace(/\./g, '\\.')}[_.]`)
  return files.find((f) => f.startsWith('rollout-') && /\.jsonl(\.zst)?$/.test(f) && named.test(f))
}

/**
 * Codex keeps a thread in sessions/YYYY/MM/DD/ (searched newest days first) and, once archived
 * (hidden from Codex Desktop), flat in archived_sessions/ under the same name.
 */
export async function codexRollout(id: string, home = homedir()): Promise<{ path: string; archived: boolean } | undefined> {
  if (!safeId(id)) return undefined
  const root = join(codexHome(home), 'sessions')
  const desc = (l: string[]) => l.sort().reverse()
  for (const y of desc(await dirs(root)))
    for (const m of desc(await dirs(join(root, y))))
      for (const d of desc(await dirs(join(root, y, m)))) {
        const day = join(root, y, m, d)
        const hit = rolloutOf(await readdir(day).catch(() => [] as string[]), id)
        if (hit) return { path: join(day, hit), archived: false }
      }
  const archive = join(codexHome(home), 'archived_sessions')
  const hit = rolloutOf(await readdir(archive).catch(() => [] as string[]), id)
  return hit ? { path: join(archive, hit), archived: true } : undefined
}

/** A compressed rollout, read whole; undefined where this Node can't decompress zstd. */
async function zstdLines(path: string): Promise<string[] | undefined> {
  const unzip = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (!unzip) return undefined
  return unzip(await readFile(path)).toString('utf8').split('\n').filter((l) => l.trim())
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
 * Claude Code, and Qoder, which keeps the same log: the last main-thread assistant entry.
 * Its input does not include the cache, so the context is input plus cache reads and writes;
 * Qoder 1.1.72 writes 0 tokens there, and only the share of the window as context_usage_ratio.
 * The latest compact_boundary entry names the last compaction.
 */
export function claudeContext(lines: string[]): SessionContext | undefined {
  let compactionKey: string | undefined
  for (let i = lines.length - 1; i >= 0 && !compactionKey; i--) {
    if (!lines[i].includes('compact_boundary')) continue
    const x = parse(lines[i])
    if (x?.type === 'system' && x.subtype === 'compact_boundary' && !x.isSidechain) compactionKey = String(x.uuid ?? x.timestamp ?? i)
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const x = parse(lines[i])
    if (x?.type !== 'assistant' || x.isSidechain) continue
    // Placeholder replies Claude Code writes after an interruption or API error carry no real usage.
    if (x.message?.model === '<synthetic>') continue
    const u = x.message?.usage
    const input = n(u?.input_tokens)
    if (input === undefined) continue
    const used = input + (n(u.cache_read_input_tokens) ?? 0) + (n(u.cache_creation_input_tokens) ?? 0)
    const model = typeof x.message.model === 'string' ? x.message.model : undefined
    // Qoder writes 0 tokens and only how full the context is (context_usage_ratio, 0–1).
    const share = n(u.context_usage_ratio)
    if (!used && share !== undefined && share > 0 && share <= 1) return { share, model, ...(compactionKey ? { compactionKey } : {}) }
    if (!used) continue
    return { used, model, ...(compactionKey ? { compactionKey } : {}) }
  }
  return compactionKey ? { compactionKey } : undefined
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

/** A step of Antigravity's transcript with token counts (its MODEL / PLANNER_RESPONSE steps), at any depth. */
const counted = (o: Record<string, any>) => typeof (o.output_tokens ?? o.outputTokens) === 'number'

/**
 * Antigravity: what the latest turn cost, from its transcript (over ACP it sends only how full the
 * context is). The turn is every step with token counts after the user's latest input; its input
 * counts cache reads (as Gemini reports them), so they are taken out of it.
 */
export function antigravityContext(lines: string[]): SessionContext | undefined {
  let user = -1
  for (let i = lines.length - 1; i >= 0 && user < 0; i--) if (/USER_INPUT/.test(lines[i]) && !/"output_?[tT]okens"/.test(lines[i])) user = i
  const steps: { i: number; u: Record<string, any> }[] = []
  for (let i = Math.max(0, user + 1); i < lines.length; i++) {
    if (!/"output_?[tT]okens"/.test(lines[i])) continue
    const u = find(parse(lines[i]), counted, 6)
    if (u) steps.push({ i, u })
  }
  // No user input in the part read: only the newest step is surely this turn's.
  const turnSteps = user < 0 ? steps.slice(-1) : steps
  if (!turnSteps.length) return undefined
  const sum = (key: string, alt: string) => {
    const v = turnSteps.map((s) => n(s.u[key] ?? s.u[alt]))
    return v.some((x) => x !== undefined) ? v.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined
  }
  const output = sum('output_tokens', 'outputTokens')
  const input = sum('input_tokens', 'inputTokens')
  const cachedRead = sum('cache_read_tokens', 'cacheReadTokens')
  const turn: MessageUsage = {
    input: input !== undefined ? Math.max(0, input - (cachedRead ?? 0)) : undefined,
    output,
    cachedRead: cachedRead || undefined
  }
  for (const k of Object.keys(turn) as (keyof MessageUsage)[]) if (turn[k] === undefined) delete turn[k]
  turn.total = (turn.input ?? 0) + (turn.output ?? 0)
  const last = turnSteps[turnSteps.length - 1]
  // The step itself names the turn (the part read moves as the file grows, so not its position).
  return { turn, turnKey: `${lines[last.i].length}:${lines[last.i].slice(0, 160)}` }
}

export async function readSessionContext(kind: SessionLogKind, sessionId: string, home = homedir()): Promise<SessionContext | undefined> {
  if (!safeId(sessionId)) return undefined
  try {
    if (kind === 'codex') {
      const f = (await codexRollout(sessionId, home))?.path
      if (!f) return undefined
      const lines = f.endsWith('.zst') ? await zstdLines(f) : await tailLines(f)
      return lines && codexContext(lines)
    }
    if (kind === 'claude') {
      const root = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
      const f = await inAnyFolder(root, `${sessionId}.jsonl`)
      return f ? claudeContext(await tailLines(f)) : undefined
    }
    if (kind === 'qoder') {
      // QODER_CONFIG_DIR moves it; the China site keeps its own folder.
      const roots = process.env.QODER_CONFIG_DIR ? [process.env.QODER_CONFIG_DIR] : [join(home, '.qoder'), join(home, '.qoder-cn')]
      for (const root of roots) {
        const f = await inAnyFolder(join(root, 'projects'), `${sessionId}.jsonl`)
        if (f) return claudeContext(await tailLines(f))
      }
      return undefined
    }
    if (kind === 'antigravity') {
      const f = join(home, '.gemini', 'antigravity-acp', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl')
      if (!(await exists(f))) return undefined
      // The turn's last step may land in the file just after the reply ends.
      const first = antigravityContext(await tailLines(f))
      if (first) return first
      await new Promise((r) => setTimeout(r, 400))
      return antigravityContext(await tailLines(f))
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
