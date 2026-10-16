// Test harness only: declare a fixture outside the app, using its normal ACP extension API.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function declareTestAgent(data, select = true) {
  mkdirSync(data, { recursive: true })
  const config = join(data, 'backends.json')
  const backends = existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) : []
  if (!backends.some((b) => b.id === 'mock')) backends.push({
    id: 'mock', name: '演示 Agent', command: process.execPath,
    args: [fileURLToPath(new URL('../resources/mock-agent.mjs', import.meta.url))]
  })
  writeFileSync(config, JSON.stringify(backends))
  if (select) {
    const path = join(data, 'state.json')
    const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
      : { version: 1, projects: [], conversations: [], routines: [], backendSettings: {} }
    state.settings = { ...state.settings, defaultBackendId: 'mock' }
    writeFileSync(path, JSON.stringify(state))
  }
  return data
}
