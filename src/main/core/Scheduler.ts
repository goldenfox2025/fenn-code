/**
 * Runs routines (scheduled tasks). A routine either posts into a project chat,
 * where the coordinator decides what to do, or starts a fresh chat per run.
 */
import type { Routine } from '../../shared/model'
import type { Store } from '../store/Store'
import type { AppCore } from './AppCore'
import { nextRun } from './schedule'
import { t } from '../../shared/i18n'

export class Scheduler {
  private timer?: NodeJS.Timeout
  private running = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly core: AppCore
  ) {}

  private stopped = true

  /**
   * Wakes at the next routine's due time (re-checking at least every
   * `maxWaitMs`, since routines can be added or edited meanwhile), so a
   * routine fires within a second of its time rather than up to one poll late.
   */
  start(maxWaitMs = 20_000): void {
    this.stopped = false
    const loop = () => {
      if (this.stopped) return
      // Catch up on anything that came due while the app was closed (once each).
      void this.tick()
      const due = this.store.routines.filter((r) => r.enabled && r.nextRunAt).map((r) => r.nextRunAt! - Date.now())
      const wait = Math.min(maxWaitMs, ...due.filter((d) => d > 0))
      this.timer = setTimeout(loop, Math.max(250, wait + 50))
    }
    loop()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  /** Recomputes when a routine should next fire; `slot` is the time the run that just finished was due. */
  schedule(r: Routine, slot?: number): Routine {
    let next: number | undefined
    try {
      next = r.enabled ? nextRun(r.schedule, Date.now(), r.lastRunAt, slot) : undefined
    } catch (e) {
      return { ...r, nextRunAt: undefined, lastError: e instanceof Error ? e.message : String(e) }
    }
    return { ...r, nextRunAt: next }
  }

  /**
   * Runs every routine that is due. Routines aimed at different places run
   * side by side; ones aimed at the same chat or project take turns.
   */
  async tick(now = Date.now()): Promise<void> {
    const lanes = new Map<string, string[]>()
    for (const r of this.store.routines) {
      if (!(r.enabled && r.nextRunAt && r.nextRunAt <= now && !this.running.has(r.id))) continue
      const lane = r.target.projectId ?? r.target.conversationId ?? r.id
      lanes.set(lane, [...(lanes.get(lane) ?? []), r.id])
    }
    await Promise.all(
      [...lanes.values()].map(async (ids) => {
        for (const id of ids) await this.run(id, now)
      })
    )
  }

  /** `now` is the clock the run is judged by (tests pass a fake one). */
  async run(id: string, now = Date.now()): Promise<void> {
    const r = this.store.routines.find((x) => x.id === id)
    if (!r || this.running.has(id)) return
    this.running.add(id)
    const slot = r.nextRunAt
    const stamp = new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    let conversationId: string | undefined
    let lastError: string | undefined
    // A card's refresh that ends without putting the card (every call refused, say) failed, even with no error.
    const cardBefore = r.widgetId ? this.store.boardWidgets.find((w) => w.id === r.widgetId)?.updatedAt : undefined
    try {
      const project = this.store.project(r.target.projectId)
      if (project) {
        conversationId = project.conversationId
        await this.core.chat.send(conversationId, `【${t('定时任务')} · ${r.name}】\n${r.prompt}`, { unattended: true })
      } else if (r.target.conversationId && this.store.conversation(r.target.conversationId)) {
        conversationId = r.target.conversationId
        await this.core.chat.send(conversationId, r.prompt, { unattended: true })
      } else {
        const conv = this.core.chat.createConversation({
          kind: 'chat',
          title: `${r.name} · ${stamp}`,
          routineId: r.id,
          backendId: this.core.resolveBackend(r.backendId)
        })
        conversationId = conv.id
        await this.core.chat.send(conv.id, r.prompt, { unattended: true })
      }
      const last = this.store.messagesOf(conversationId).filter((m) => m.role === 'assistant').pop()
      if (last?.state === 'error') lastError = last.error ?? t('运行出错')
      else if (r.widgetId && this.store.boardWidgets.find((w) => w.id === r.widgetId)?.updatedAt === cardBefore) lastError = t('这次运行没有更新卡片')
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    } finally {
      this.running.delete(id)
    }
    const fresh = this.store.routines.find((x) => x.id === id)
    if (!fresh) return
    // A manual 「立即运行」 before its time leaves the regular slot where it was.
    const ranEarly = slot !== undefined && slot > Math.max(now, Date.now())
    const updated = ranEarly
      ? { ...fresh, lastRunAt: Date.now(), lastRunConversationId: conversationId, lastError }
      : this.schedule({ ...fresh, lastRunAt: Date.now(), lastRunConversationId: conversationId, lastError }, slot)
    // A one-off routine disables itself after running.
    // A one-off routine disables itself after its scheduled run; running it early by hand keeps that run.
    if (updated.schedule.kind === 'once' && !ranEarly) Object.assign(updated, { enabled: false, nextRunAt: undefined })
    this.store.putRoutine(updated)
    this.core.publish({ type: 'routine', routine: updated })
    // A card's refresh keeps only its latest run, and says nothing unless it failed.
    if (r.widgetId && !lastError && fresh.lastRunConversationId && fresh.lastRunConversationId !== conversationId && this.store.conversation(fresh.lastRunConversationId)?.routineId === r.id)
      await this.core.deleteConversation(fresh.lastRunConversationId).catch(() => undefined)
    if (r.widgetId && !lastError) return
    this.core.publish({ type: 'toast', level: lastError ? 'error' : 'info', text: lastError ? t('定时任务「{0}」失败：{1}', r.name, lastError) : t('定时任务「{0}」已运行', r.name) })
  }
}
