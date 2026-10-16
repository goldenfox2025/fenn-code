/**
 * The opt-in ACP debug log (设置 → 关于 → 诊断): every message to and from an
 * agent, appended to logs/acp-<agent>-<date>.jsonl in the data folder. Off by
 * default; it holds conversation content, so it stays on this computer.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let dir: string | undefined
const decoder = new TextDecoder()

export function setAcpDebugLog(folder: string | undefined): void {
  dir = folder
  if (dir) mkdirSync(dir, { recursive: true })
}

export function logAcp(agent: string, direction: 'in' | 'out', chunk: Uint8Array): void {
  if (!dir) return
  const name = agent.replace(/[^\w.-]+/g, '_') || 'agent'
  try {
    appendFileSync(join(dir, `acp-${name}-${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), direction, text: decoder.decode(chunk) }) + '\n')
  } catch {
    // A log that can't be written must never break the conversation.
  }
}

/** Passes bytes through unchanged, copying them to the log while it is on. */
export function tap(agent: string, direction: 'in' | 'out'): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      logAcp(agent, direction, chunk)
      controller.enqueue(chunk)
    }
  })
}
