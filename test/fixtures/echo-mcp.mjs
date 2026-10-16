// A tiny stdio MCP server for tests: one tool, `echo`, that also reports ECHO_TOKEN.
import { createInterface } from 'node:readline'

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize')
    return reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } })
  if (msg.method === 'tools/list')
    return reply(msg.id, { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })
  if (msg.method === 'tools/call')
    return reply(msg.id, { content: [{ type: 'text', text: `echo: ${msg.params.arguments.text} (token=${process.env.ECHO_TOKEN ?? 'none'})` }] })
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }) + '\n')
})
