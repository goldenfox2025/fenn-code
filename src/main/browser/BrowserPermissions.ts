import { randomUUID } from 'node:crypto'
import type { BrowserPermit, BrowserPolicy } from './BrowserTools'
import type { PermissionRequest } from '../../shared/contract'

/** Run-scoped domain grants; ending a turn invalidates every outstanding decision. */
export class BrowserPermissions implements BrowserPolicy {
  private runs = new Map<string, string>()
  private grants = new Map<string, Set<string>>()
  constructor(private ask: (id: string, request: Omit<PermissionRequest, 'requestId' | 'sessionId'>) => Promise<string | null>) {}
  begin(id: string) { this.end(id); const run = randomUUID(); this.runs.set(id, run); return run }
  current(id: string) { return this.runs.get(id) }
  end(id: string) { this.runs.delete(id); this.grants.delete(id) }
  active(id: string, runId?: string) { return this.runs.has(id) && (!runId || this.runs.get(id) === runId) }
  assert(id: string, runId: string) { if (!this.active(id, runId)) throw Error('任务已停止或已被替换。') }
  async require(input: BrowserPermit, runId: string) {
    const id = input.ownerId; this.assert(id, runId)
    const key = `${input.target}:${input.capability}`, grants = this.grants.get(id)
    if (grants?.has(key) || input.capability === 'browser.read' && grants?.has(`${input.target}:browser.interact`)) return
    const decision = await this.ask(id, { title: input.title, detail: [input.target, input.detail].filter(Boolean).join('\n\n'), options: [
      { id: 'once', label: '允许一次', kind: 'allow_once' },
      ...(input.taskScope ? [{ id: 'task', label: '本轮允许', kind: 'allow_once' as const }] : []),
      { id: 'deny', label: '拒绝', kind: 'reject_once' }
    ] })
    this.assert(id, runId)
    if (decision !== 'once' && decision !== 'task') throw Error('操作未获授权。')
    if (decision === 'task' && input.taskScope) { if (!this.grants.has(id)) this.grants.set(id, new Set()); this.grants.get(id)!.add(key) }
  }
  async choose(id: string, runId: string, choices: { id: string; label: string }[]) {
    this.assert(id, runId)
    const decision = await this.ask(id, { title: '选择要使用的浏览器', detail: '只会创建新的后台标签页，你正在使用的页面保持原位。', options: [...choices.map(choice => ({ ...choice, kind: 'allow_once' as const })), { id: 'cancel', label: '取消', kind: 'reject_once' }] })
    this.assert(id, runId)
    return choices.some(choice => choice.id === decision) ? decision! : undefined
  }
}
