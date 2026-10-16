import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { textOf } from '../src/main/core/ChatService'
import { makeCore, until } from './helpers'

const lastReply = (store: any, id: string) =>
  textOf(store.messagesOf(id).filter((m: any) => m.role === 'assistant').pop())

async function ask(core: any, store: any, text: string) {
  const c = await core.startChat({ text, backendId: 'mock' })
  await until(() => store.conversation(c.id)!.status !== 'working' && store.messagesOf(c.id).length >= 2 && lastReply(store, c.id))
  return lastReply(store, c.id)
}

describe('connectors', () => {
  it('gives every agent a local-command connector, with its secret env, never shown to the UI', async () => {
    const { core, store, dispose } = await makeCore()
    const saved = await core.saveConnector({
      name: 'echo',
      enabled: true,
      kind: 'command',
      command: process.execPath,
      args: [join(__dirname, 'fixtures/echo-mcp.mjs')],
      secrets: { ECHO_TOKEN: 's3cret' }
    })
    expect(saved.secretKeys).toEqual(['ECHO_TOKEN'])
    expect(JSON.stringify(await core.listConnectors())).not.toContain('s3cret')
    expect(await ask(core, store, '用连接器 echo echo')).toContain('echo: ping (token=s3cret)')

    // Disabled connectors are not offered.
    await core.saveConnector({ ...saved, enabled: false })
    expect(await ask(core, store, '用连接器 echo echo')).toContain('没有名为 echo 的连接器')
    await dispose()
  }, 40000)

  it('passes request headers to a remote connector', async () => {
    let auth = ''
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        auth = String(req.headers.authorization ?? '')
        const msg = JSON.parse(body)
        if (msg.id === undefined) return res.writeHead(202).end()
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } }
            : msg.method === 'tools/list'
              ? { tools: [{ name: 'whoami', description: 'x', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: `you sent ${auth}` }] }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
    const { core, store, dispose } = await makeCore()
    await core.saveConnector({ name: 'remote', enabled: true, kind: 'http', url, secrets: { Authorization: 'Bearer abc' } })
    expect(await ask(core, store, '用连接器 remote whoami')).toContain('you sent Bearer abc')
    server.close()
    await dispose()
  }, 40000)
})
