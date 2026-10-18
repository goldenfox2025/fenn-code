/**
 * Background tidying of a new chat after its first exchange:
 *  - gives it a short title, made here from what the user wrote: no agent is asked,
 *    so naming a chat never spends the user's quota;
 *  - when the chat has no folder and its first turn clearly worked inside one
 *    folder the app already knows, attaches the chat to that folder, silently.
 * It never files a chat into a project: projects are their own chat plus threads.
 */
import type { Conversation, Message } from '../../shared/model'
import type { Store } from '../store/Store'
import { textOf, type ChatService } from './ChatService'
import { localTitle, titleFrom } from './titles'

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
    /** Folders the app knows (recent ones, projects', the default). */
    private readonly knownFolders: () => string[] = () => [],
    private readonly attachFolder: (conversationId: string, folder: string) => void = () => {},
    /** The app's own scratch spaces: work there says nothing about the user's folders. */
    private readonly ignored: string[] = []
  ) {
    chat.removedListeners.add((id) => {
      this.checked.delete(id)
      this.retitled.delete(id)
    })
  }

  private retitled = new Set<string>()

  /**
   * Called after every turn. After the first exchange: a title, and a folder if one clearly fits.
   * If that exchange was only a greeting, the title is made again from the first message with real content.
   */
  async consider(conv: Conversation, reply: Message): Promise<void> {
    if (conv.kind !== 'chat' || reply.state !== 'done') return
    const users = this.store.messagesOf(conv.id).filter((m) => !m.hidden && m.role === 'user')
    const firstUser = users[0]
    if (!firstUser) return
    const first = !this.checked.has(conv.id)
    const latest = textOf(users[users.length - 1]).trim()
    // An agent command (/compact, /always-approve on) is not content to name the chat after.
    const command = /^\/\S+/.test(latest)
    const again = !first && !command && conv.titleAuto && isSmallTalk(textOf(firstUser)) && !isSmallTalk(latest) &&
      users.length >= 2 && users.length <= 3 && !this.retitled.has(conv.id)
    if (!first && !again) return
    this.checked.add(conv.id)
    if (again) this.retitled.add(conv.id)

    if (first && !conv.cwd && !conv.routineId) {
      const folder = folderOfTurn(reply, this.knownFolders(), this.ignored)
      if (folder) this.attachFolder(conv.id, folder)
    }

    // Only a title the app gave: one the user typed (or a routine's name) is never replaced.
    const current = this.store.conversation(conv.id)
    if (!current || current.title !== conv.title) return
    if (!(again || conv.title === titleFrom(textOf(firstUser)))) return
    const title = localTitle(again ? latest : textOf(firstUser))
    if (title) this.chat.patchConversation(conv.id, { title: this.distinct(title, conv.id), titleAuto: true })
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
