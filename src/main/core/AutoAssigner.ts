/**
 * Background triage of a new chat after its first exchange, in one agent call:
 *  - gives it a short title (as Claude does);
 *  - files a loose chat into the right project, if one clearly fits.
 * The question goes through the same backend contract as everything else.
 */
import type { Conversation, Message } from '../../shared/model'
import type { BackendManager } from '../backends/BackendManager'
import type { Store } from '../store/Store'
import { textOf, type ChatService } from './ChatService'
import { titleFrom } from './titles'
import { t } from '../../shared/i18n'

export class AutoAssigner {
  private checked = new Set<string>()

  /** The title, with a number added if another chat already has it. */
  private distinct(title: string, id: string): string {
    const taken = new Set(this.store.conversations.filter((c) => c.kind === 'chat' && c.id !== id).map((c) => c.title))
    if (!taken.has(title)) return title
    for (let n = 2; ; n++) if (!taken.has(`${title} ${n}`)) return `${title} ${n}`
  }

  constructor(
    private readonly store: Store,
    private readonly chat: ChatService,
    private readonly backends: BackendManager
  ) {}

  private retitled = new Set<string>()

  /**
   * Called after every turn. After the first exchange: a title, and a project if one clearly fits.
   * If that exchange was only a greeting, the title is made again once the chat has real content.
   * Resolves with the project id it chose, if any.
   */
  async consider(conv: Conversation, reply: Message): Promise<string | undefined> {
    if (conv.kind !== 'chat' || reply.state !== 'done') return
    const messages = this.store.messagesOf(conv.id).filter((m) => !m.hidden)
    const users = messages.filter((m) => m.role === 'user')
    const firstUser = users[0]
    if (!firstUser) return
    const first = !this.checked.has(conv.id)
    const again = !first && conv.titleAuto && isSmallTalk(textOf(firstUser)) && users.length >= 2 && users.length <= 3 && !this.retitled.has(conv.id)
    if (!first && !again) return
    this.checked.add(conv.id)
    if (again) this.retitled.add(conv.id)

    const wantTitle = again || conv.title === titleFrom(textOf(firstUser))
    // Routine runs go where the routine says; guessing a project for each would cost an agent call per run.
    const projects = !conv.projectId && !conv.routineId && this.store.settings.autoAssignChats ? this.store.projects.filter((p) => !p.archived) : []
    if (!wantTitle && !projects.length) return

    const exchange = again ? messages.slice(-4) : [firstUser, reply]
    const chatText = exchange
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${textOf(m).slice(0, m.role === 'user' ? 1500 : 800)}`)
      .join('\n\n')
    const others = this.store.conversations
      .filter((c) => c.kind === 'chat' && c.id !== conv.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((c) => c.title)
    const prompt = [
      '<<classify>>',
      '这是一个后台整理任务，不要使用任何工具，只输出一行 JSON：{"title": "...", "project": "..."}。',
      '- title：概括下面对话主题的简短标题，用对话的语言，不超过 16 个字，不加引号和句号。要具体到这次对话的内容，不要用“简单问候”“闲聊”这类笼统的词。',
      ...(others.length ? [`- title 不要和这些已有标题重复：${others.join('；')}`] : []),
      projects.length
        ? '- project：如果对话明显属于下面某个项目，填它的 id；否则填 none。'
        : '- project：填 none。',
      ...(projects.length
        ? [
            '<projects>',
            ...projects.map((p) => {
              const threads = this.store.conversations
                .filter((c) => c.projectId === p.id && c.kind !== 'project')
                .slice(-8)
                .map((c) => c.title)
              const desc = [p.name, p.description, p.instructions?.slice(0, 300), threads.join('；')].filter(Boolean).join(' / ')
              return `<project id="${p.id}">${desc}</project>`
            }),
            '</projects>'
          ]
        : []),
      `<chat>${chatText}</chat>`
    ].join('\n')

    let answer = ''
    try {
      answer = await this.backends.ask(conv.backendId, prompt, { timeoutMs: 90_000 })
    } catch {
      return
    }
    const parsed = parseAnswer(answer)
    const current = this.store.conversation(conv.id)
    if (!current) return

    if (wantTitle && parsed.title && current.title === conv.title) {
      this.chat.patchConversation(conv.id, { title: this.distinct(parsed.title.slice(0, 40), conv.id), titleAuto: true })
    }
    const match = matchProject(parsed.project, projects)
    // The user may have moved it themselves while we were thinking.
    if (!match || this.store.conversation(conv.id)?.projectId) return
    this.chat.patchConversation(conv.id, { projectId: match.id })
    this.chat.addMessage(conv.id, 'system', [{ type: 'text', text: t('已自动归入项目「{0}」', match.name) }])
    return match.id
  }
}

/** A first message that says nothing about the topic yet (a greeting or a few characters). */
export function isSmallTalk(text: string): boolean {
  const t = text.trim().replace(/[\s!！。.,，~～?？]+$/g, '')
  return t.length <= 6 || /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|早上好|晚上好|下午好|谢谢)/i.test(t)
}

/** Every {...} in the answer that parses as JSON, innermost-first candidates included. */
function jsonObjects(answer: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (let start = answer.indexOf('{'); start >= 0; start = answer.indexOf('{', start + 1)) {
    for (let end = answer.indexOf('}', start); end >= 0; end = answer.indexOf('}', end + 1)) {
      try {
        const v = JSON.parse(answer.slice(start, end + 1))
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          out.push(v)
          break
        }
      } catch {
        /* keep extending */
      }
    }
  }
  return out
}

export function parseAnswer(answer: string): { title?: string; project?: string } {
  const v = jsonObjects(answer).find((o) => 'title' in o || 'project' in o)
  if (v) {
    return {
      title: typeof v.title === 'string' ? v.title.trim().replace(/^["'「]|["'」。.]$/g, '') || undefined : undefined,
      project: typeof v.project === 'string' ? v.project.trim() : undefined
    }
  }
  // No usable JSON: a bare answer like `project: launch` still says something.
  const project = answer.match(/project["']?\s*[:：]\s*["']?([^"'\n,}]+)/i)?.[1]?.trim()
  return { project }
}

/**
 * Models answer with the id, an id prefix, the project's name, or a name in
 * quotes or brackets; accept any of these, but only when it's unambiguous.
 */
export function matchProject<P extends { id: string; name: string }>(answer: string | undefined, projects: P[]): P | undefined {
  if (!answer) return
  const a = answer.trim().replace(/^[「『"'“《【\[(（]+|[」』"'”》】\])）。.]+$/g, '').trim()
  const lower = a.toLowerCase()
  if (!a || /^(none|null|无|没有|不属于|n\/a)$/i.test(a)) return
  const one = (list: P[]) => (list.length === 1 ? list[0] : undefined)
  return (
    projects.find((p) => p.id === a) ??
    one(projects.filter((p) => p.name.trim().toLowerCase() === lower)) ??
    (a.length >= 4 ? one(projects.filter((p) => p.id.startsWith(a))) : undefined) ??
    one(projects.filter((p) => a.includes(p.id))) ??
    one(projects.filter((p) => p.name.trim().length >= 2 && lower.includes(p.name.trim().toLowerCase())))
  )
}
