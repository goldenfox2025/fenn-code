/**
 * A minimal MCP (Model Context Protocol) server over streamable HTTP, bound to
 * localhost. Each agent session gets its own URL token, so a tool call always
 * knows which conversation it came from. Responses are plain JSON (allowed by
 * the streamable-HTTP transport), which keeps this dependency-free.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { HostToolServer } from '../../shared/contract'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, ctx: { conversationId: string }): Promise<unknown> | unknown
  /** Other names models use for a parameter, e.g. { instructions: ['task', 'prompt'] }. */
  aliases?: Record<string, string[]>
  /** A correct call's arguments, shown when a call fails so the model can retry. */
  example?: Record<string, unknown>
}

const keyOf = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase()

/**
 * Makes a tool call from a less exact model usable: arguments sent as a JSON
 * string, camelCase or differently cased names, known synonyms, numbers and
 * booleans written as strings, a list where text is expected, and a lone
 * value for a tool's only missing required text parameter.
 */
export function coerceArgs(tool: Pick<ToolDef, 'inputSchema' | 'aliases'>, raw: unknown): Record<string, unknown> {
  let args: unknown = raw
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = { __text: args }
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = { __text: args }
  const props = ((tool.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {}) as Record<string, { type?: string }>
  const required = ((tool.inputSchema as { required?: string[] }).required ?? []) as string[]
  const lookup = new Map<string, string>()
  for (const name of Object.keys(props)) {
    lookup.set(keyOf(name), name)
    for (const a of tool.aliases?.[name] ?? []) lookup.set(keyOf(a), name)
  }
  const out: Record<string, unknown> = {}
  const extra: unknown[] = []
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    const name = lookup.get(keyOf(k))
    if (name && out[name] === undefined) out[name] = v
    else if (!name) extra.push(v)
  }
  for (const [name, spec] of Object.entries(props)) {
    const v = out[name]
    if (v === undefined) continue
    if (spec.type === 'string' && Array.isArray(v)) out[name] = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')
    else if (spec.type === 'string' && v !== null && typeof v === 'object') out[name] = JSON.stringify(v)
    else if (spec.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) out[name] = String(v)
    else if ((spec.type === 'integer' || spec.type === 'number') && typeof v === 'string' && v.trim() && !isNaN(Number(v))) out[name] = Number(v)
    else if (spec.type === 'boolean' && typeof v === 'string') out[name] = !/^(false|no|0|否|不)$/i.test(v.trim())
    else if (spec.type === 'array' && typeof v === 'string') {
      try {
        const parsed = JSON.parse(v)
        if (Array.isArray(parsed)) out[name] = parsed
      } catch {
        /* leave as is */
      }
    }
  }
  // One stray value and exactly one missing required text parameter: that's what it was meant for.
  const missing = required.filter((r) => out[r] === undefined || out[r] === '')
  const strays = extra.filter((v) => typeof v === 'string' && v.trim())
  if (missing.length === 1 && strays.length === 1 && props[missing[0]]?.type === 'string') out[missing[0]] = strays[0]
  return out
}

/** Finds a tool by the name a model used: any case, - or _, with or without a server prefix. */
export function findTool<T extends { name: string }>(tools: T[], name: unknown): T | undefined {
  if (typeof name !== 'string') return undefined
  const norm = (n: string) => n.toLowerCase().replace(/-/g, '_')
  const want = norm(name)
  return (
    tools.find((t) => t.name === name) ??
    tools.find((t) => norm(t.name) === want) ??
    tools.find((t) => want.endsWith('__' + norm(t.name)) || want.endsWith('.' + norm(t.name)) || want.endsWith('/' + norm(t.name)))
  )
}

/** Return this from a tool to send rich MCP content (e.g. an image) instead of text. */
export class ToolContent {
  constructor(readonly content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]) {}
}

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export class ToolServer {
  private server?: Server
  private port = 0
  private tokens = new Map<string, { conversationId: string; tools: () => ToolDef[] }>()

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
  }

  stop(): void {
    this.server?.close()
    this.server = undefined
  }

  /** Issues an endpoint whose tools are evaluated per call (so they can depend on live state). */
  endpoint(conversationId: string, tools: () => ToolDef[]): Extract<HostToolServer, { url: string }> {
    const token = randomBytes(12).toString('hex')
    this.tokens.set(token, { conversationId, tools })
    return { name: 'ancora', url: `http://127.0.0.1:${this.port}/mcp/${token}` }
  }

  revoke(conversationId: string): void {
    for (const [t, v] of this.tokens) if (v.conversationId === conversationId) this.tokens.delete(t)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/mcp\/([a-f0-9]+)$/.exec(req.url ?? '')
    const binding = m && this.tokens.get(m[1])
    if (!binding) return end(res, 404, { error: 'unknown endpoint' })
    if (req.method === 'GET') return end(res, 405, null) // no server-initiated stream
    if (req.method === 'DELETE') return end(res, 200, null)
    if (req.method !== 'POST') return end(res, 405, null)

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return end(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    const batch = Array.isArray(body) ? body : [body]
    const out: unknown[] = []
    for (const msg of batch as { id?: string | number; method?: string; params?: any }[]) {
      if (msg.id === undefined || msg.id === null) continue // notification
      out.push(await this.dispatch(msg.id, msg.method ?? '', msg.params ?? {}, binding))
    }
    if (!out.length) return end(res, 202, null)
    end(res, 200, Array.isArray(body) ? out : out[0])
  }

  private async dispatch(
    id: string | number,
    method: string,
    params: any,
    binding: { conversationId: string; tools: () => ToolDef[] }
  ): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const v = SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0]
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: v,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'ancora', version: '0.1.0' },
            instructions: 'Tools for working inside the Ancora app: threads, status, reactions.'
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: binding.tools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
          }
        }
      case 'tools/call': {
        const tool = findTool(binding.tools(), params.name)
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`)
        try {
          const result = await tool.run(coerceArgs(tool, params.arguments ?? {}), { conversationId: binding.conversationId })
          if (result instanceof ToolContent) return { jsonrpc: '2.0', id, result: { content: result.content, isError: false } }
          const text = typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true })
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } }
        } catch (e) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: (e instanceof Error ? e.message : String(e)) + (tool.example ? `\n正确的调用参数示例：${JSON.stringify(tool.example)}` : '')
                }
              ],
              isError: true
            }
          }
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      data += c
      if (data.length > 4_000_000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function end(res: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}
