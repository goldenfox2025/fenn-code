/**
 * Background tidying of a new chat after its first exchange:
 *  - gives it a short title (as Claude does), in one agent call;
 *  - when the chat has no folder and its first turn clearly worked inside one
 *    folder the app already knows, attaches the chat to that folder, silently.
 * It never files a chat into a project: projects are their own chat plus threads.
 */
import type { Conversation, Message } from '../../shared/model'
import type { BackendManager } from '../backends/BackendManager'
import type { Store } from '../store/Store'
import { textOf, type ChatService } from './ChatService'
import { titleFrom } from './titles'

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
    private readonly backends: BackendManager,
    /** Folders the app knows (recent ones, projects', the default). */
    private readonly knownFolders: () => string[] = () => [],
    private readonly attachFolder: (conversationId: string, folder: string) => void = () => {},
    /** The app's own scratch spaces: work there says nothing about the user's folders. */
    private readonly ignored: string[] = []
  ) {}

  private retitled = new Set<string>()

  /**
   * Called after every turn. After the first exchange: a title, and a folder if one clearly fits.
   * If that exchange was only a greeting, the title is made again once the chat has real content.
   */
  async consider(conv: Conversation, reply: Message): Promise<void> {
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

    if (first && !conv.cwd && !conv.routineId) {
      const folder = folderOfTurn(reply, this.knownFolders(), this.ignored)
      if (folder) this.attachFolder(conv.id, folder)
    }

    const wantTitle = again || conv.title === titleFrom(textOf(firstUser))
    if (!wantTitle) return

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
      '这是一个后台整理任务，不要使用任何工具，只输出一行 JSON：{"title": "..."}。',
      '- title：概括下面对话主题的简短标题，用对话的语言，不超过 16 个字，不加引号和句号。要具体到这次对话的内容，不要用“简单问候”“闲聊”这类笼统的词。',
      ...(others.length ? [`- title 不要和这些已有标题重复：${others.join('；')}`] : []),
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

    if (parsed.title && current.title === conv.title) {
      this.chat.patchConversation(conv.id, { title: this.distinct(parsed.title.slice(0, 40), conv.id), titleAuto: true })
    }
  }
}

/** Absolute paths in a tool call's title and input (Windows or POSIX). */
function pathsIn(text: string): string[] {
  const plain = text.replace(/\\\\/g, '\\')
  return [...plain.matchAll(/[A-Za-z]:[\\/][^\s"'<>|*?]+|(?<![\w.])\/(?:[^\s"'<>|*?:/]+\/?)+/g)].map((m) => m[0].replace(/[),.;:]+$/, ''))
}

const inside = (path: string, folder: string) => {
  const win = /^[A-Za-z]:/.test(folder)
  const norm = (p: string) => (win ? p.replace(/\//g, '\\').toLowerCase() : p).replace(/[\\/]+$/, '')
  const p = norm(path)
  const f = norm(folder)
  return p === f || p.startsWith(f + (win ? '\\' : '/'))
}

/**
 * The one known folder a turn's tool calls all worked in, or nothing. Every
 * path must be inside some known folder, and one of those folders must hold
 * them all (with nested known folders, the outermost that does).
 */
export function folderOfTurn(reply: Message, known: string[], ignored: string[] = []): string | undefined {
  const paths = reply.blocks
    .flatMap((b) => (b.type === 'tool' ? pathsIn(`${b.title}\n${b.input ?? ''}`) : []))
    .filter((p) => !ignored.some((d) => inside(p, d)))
  if (!paths.length) return undefined
  const holding = known.filter((f) => paths.every((p) => inside(p, f)))
  // The outermost such folder is the one that clearly fits; a parent of it holding them too would be the outermost instead.
  return holding.sort((x, y) => x.length - y.length)[0]
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

export function parseAnswer(answer: string): { title?: string } {
  const v = jsonObjects(answer).find((o) => 'title' in o)
  return { title: v && typeof v.title === 'string' ? v.title.trim().replace(/^["'「]|["'」。.]$/g, '') || undefined : undefined }
}
