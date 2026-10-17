/**
 * Decides when to raise a desktop notification: a thread or chat now needs
 * the user (finished, waiting on a decision, or asking permission), and the
 * user isn't looking at the app. The actual OS call is injected.
 */
import type { AppEvent, Conversation, NotifyLevel, Project } from '../../shared/model'
import { t } from '../../shared/i18n'

export interface NotifierDeps {
  enabled(): boolean
  focused(): boolean
  project(id?: string): Project | undefined
  show(n: { title: string; body: string; conversationId: string }): void
}

export class Notifier {
  private last = new Map<string, Conversation['status']>()
  private needs = new Map<string, number | undefined>()
  private startedAt = new Map<string, number>()

  constructor(private readonly deps: NotifierDeps) {}

  observe(e: AppEvent): void {
    if (e.type === 'conversation-removed') {
      this.last.delete(e.id)
      this.needs.delete(e.id)
    }
    if (e.type !== 'conversation') return
    const c = e.conversation
    const prev = this.last.get(c.id)
    const seen = this.last.has(c.id)
    const prevNeed = this.needs.get(c.id)
    this.last.set(c.id, c.status)
    this.needs.set(c.id, c.needsUser?.at)
    if (c.status === 'working' && prev !== 'working') this.startedAt.set(c.id, c.updatedAt)
    // The first sighting only records the state; there's no transition to report yet.
    if (!seen) return
    const project = this.deps.project(c.projectId)
    // Chats outside projects tell the user everything, as before; a project goes by its level.
    const level: NotifyLevel = project ? (project.notify ?? 'coordinator') : 'all'
    const title = c.kind === 'project' ? (project?.name ?? c.title) : project ? `${project.name} · ${c.title}` : c.title
    const show = (body: string) => this.deps.enabled() && !this.deps.focused() && this.deps.show({ title, body, conversationId: c.id })
    // The agent needs the user in person: every level but 「无」 lets it through.
    if (c.needsUser && c.needsUser.at !== prevNeed) {
      if (level !== 'none') show(needBody(c.needsUser))
      return
    }
    if (prev === c.status || c.status === 'working') return
    const body = this.bodyFor(c, prev)
    if (!body) return
    const allowed = level === 'all' || (level === 'coordinator' && c.kind === 'project')
    if (allowed) show(body)
  }

  private bodyFor(c: Conversation, prev?: Conversation['status']): string | undefined {
    // A permission prompt is reported through needsUser.
    // What needs the user was already reported through needsUser.
    if (c.status === 'waiting') return c.needsUser ? undefined : c.kind === 'thread' ? (c.lastPreview || t('有结果了，等您查看')) : t('需要您确认一个操作')
    if (c.status === 'done' && c.kind === 'thread') return c.lastPreview ? t('已完成：{0}', c.lastPreview) : t('已完成')
    if (c.status === 'error') return t('出错了，点开查看')
    // A plain chat or the project chat finishing a reply.
    // Hidden housekeeping turns (memory flush before a handoff) don't touch updatedAt, so they stay quiet.
    const visibleReply = c.updatedAt > (this.startedAt.get(c.id) ?? Infinity)
    if (prev === 'working' && c.status === 'idle' && c.kind !== 'thread' && visibleReply) return c.lastPreview || t('回复好了')
    return undefined
  }
}

function needBody(n: NonNullable<Conversation['needsUser']>): string {
  if (n.kind === 'decision') return n.text ? t('需要您决定：{0}', n.text) : t('需要您做个决定')
  if (n.kind === 'blocked') return n.text ? t('卡住了，等您处理：{0}', n.text) : t('卡住了，等您处理')
  return t('需要您确认一个操作')
}
