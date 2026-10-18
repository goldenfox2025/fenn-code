// Bridges an MCP client speaking stdio (newline-delimited JSON-RPC) to the
// app's MCP server over HTTP. Used for agents that only support stdio MCP
// servers. Usage: node mcp-bridge.mjs <url>; extra request headers come as
// JSON in FENN_BRIDGE_HEADERS.
import { createInterface } from 'node:readline'

const url = process.argv[2]
let extra = {}
try {
  extra = JSON.parse(process.env.FENN_BRIDGE_HEADERS || '{}')
} catch {}
let session

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  try {
    const headers = { ...extra, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (session) headers['mcp-session-id'] = session
    const res = await fetch(url, { method: 'POST', headers, body: line })
    session = res.headers.get('mcp-session-id') ?? session
    if (res.status === 202 || res.status === 204) return
    const text = await res.text()
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Streamable HTTP may answer as server-sent events: one JSON message per `data:` block.
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data) process.stdout.write(JSON.stringify(JSON.parse(data)) + '\n')
      }
    } else if (text) process.stdout.write(JSON.stringify(JSON.parse(text)) + '\n')
  } catch (e) {
    if (msg.id !== undefined)
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }) + '\n')
  }
})
