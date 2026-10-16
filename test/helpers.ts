import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendManager } from '../src/main/backends/BackendManager'
import { loadPlugins } from '../src/main/backends/registry'
import { AppCore } from '../src/main/core/AppCore'
import { Store } from '../src/main/store/Store'
import { ToolServer } from '../src/main/tools/ToolServer'
import type { AppEvent } from '../src/shared/model'

export async function makeCore(dir = mkdtempSync(join(tmpdir(), 'oc-test-')), agentEnv: Record<string, string> = {}) {
  const events: AppEvent[] = []
  const store = new Store(dir)
  let core!: AppCore
  const backends = new BackendManager({
    plugins: loadPlugins(),
    settings: { get: (id) => store.backendSettings(id), set: (id, k, v) => store.setBackendSetting(id, k, v) },
    resourcesDir: join(__dirname, '../resources'),
    nodeCommand: { command: process.execPath, env: agentEnv },
    defaultCwd: process.cwd(),
    emit: (e) => {
      if (e.type === 'permission') core.chat.routePermission(e.backendId, e.request)
      if (e.type === 'permission-dropped') core.chat.permissionDropped(e.requestId)
    }
  })
  const tools = new ToolServer()
  await tools.start()
  core = new AppCore(store, backends, (e) => {
    events.push(e)
    if (e.type === 'permission') void core.respondPermission(e.request.requestId, e.request.options[0].id)
  }, 'linux', tools)
  const dispose = async () => {
    await backends.disposeAll()
    tools.stop()
    store.flush()
  }
  return { core, store, events, dir, dispose }
}

export async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}
