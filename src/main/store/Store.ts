/**
 * JSON-file persistence: one state file for metadata, one file per
 * conversation for its messages. Writes are debounced and atomic.
 */
import { demoAgentEnabled } from '../demo'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings, Connector, Conversation, Message, Project, Routine } from '../../shared/model'

interface StateFile {
  version: 1
  projects: Project[]
  conversations: Conversation[]
  routines: Routine[]
  connectors?: Connector[]
  settings: AppSettings
  backendSettings: Record<string, Record<string, string>>
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultBackendId: demoAgentEnabled() ? 'mock' : 'codex',
  theme: 'system',
  // A login name (root, j.doe) is not what people want to be called; ask in settings instead.
  userName: '',
  autoAssignChats: true,
  notifications: true
}


export class Store {
  private state: StateFile
  private messages = new Map<string, Message[]>()
  private dirtyState = false
  private dirtyMessages = new Set<string>()
  private dirtyVariants = new Set<string>()
  private timer?: NodeJS.Timeout
  /** Conversations whose turn was cut off by the last shutdown or crash. */
  readonly interrupted: string[] = []

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'messages'), { recursive: true })
    const loaded = readJson<StateFile>(join(dir, 'state.json'))
    this.state = {
      version: 1,
      projects: loaded?.projects ?? [],
      conversations: loaded?.conversations ?? [],
      routines: loaded?.routines ?? [],
      connectors: loaded?.connectors ?? [],
      settings: { ...DEFAULT_SETTINGS, ...loaded?.settings },
      backendSettings: loaded?.backendSettings ?? {}
    }
    // Data from before the first-run guide existed: the user is already set up, so don't guide them again.
    const s = this.state
    if (loaded && loaded.settings?.onboarded === undefined && (s.conversations.length || s.projects.length || s.settings.userName)) {
      s.settings.onboarded = true
      this.dirtyState = true
    }
    // Anything that was mid-turn when the app quit is no longer running.
    for (const c of this.state.conversations) {
      // A turn that was running when the app last quit was cut off.
      if (c.status === 'working') this.interrupted.push(c.id)
      if (c.status === 'working' || (c.status === 'waiting' && c.kind !== 'thread')) c.status = 'idle'
    }
  }

  // ---- projects -----------------------------------------------------------
  get projects(): Project[] {
    return this.state.projects
  }
  project(id: string | undefined): Project | undefined {
    return id ? this.state.projects.find((p) => p.id === id) : undefined
  }
  putProject(p: Project): void {
    upsert(this.state.projects, p)
    this.touch()
  }
  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    this.touch()
  }

  // ---- conversations ------------------------------------------------------
  get conversations(): Conversation[] {
    return this.state.conversations
  }
  conversation(id: string | undefined): Conversation | undefined {
    return id ? this.state.conversations.find((c) => c.id === id) : undefined
  }
  putConversation(c: Conversation): void {
    upsert(this.state.conversations, c)
    this.touch()
  }
  removeConversation(id: string): void {
    this.state.conversations = this.state.conversations.filter((c) => c.id !== id)
    this.messages.delete(id)
    this.variants.delete(id)
    for (const name of [`${id}.json`, `${id}.variants.json`])
      for (const ext of ['', '.bak']) rmSync(join(this.dir, 'messages', name + ext), { force: true })
    this.touch()
  }

  // ---- messages -----------------------------------------------------------
  messagesOf(conversationId: string): Message[] {
    let list = this.messages.get(conversationId)
    if (!list) {
      list = readJson<Message[]>(join(this.dir, 'messages', `${conversationId}.json`)) ?? []
      // A reply cut off by a quit: drop it if nothing was said yet (unless a thread card hangs on it).
      list = list.filter(
        (m) => !(m.state === 'streaming' && !m.blocks.length && !this.conversations.some((c) => c.anchorMessageId === m.id))
      )
      for (const m of list)
        if (m.state === 'streaming') {
          m.state = 'cancelled'
          m.interrupted = true
        }
      this.messages.set(conversationId, list)
    }
    return list
  }
  message(conversationId: string, id: string): Message | undefined {
    return this.messagesOf(conversationId).find((m) => m.id === id)
  }
  putMessage(m: Message): void {
    upsert(this.messagesOf(m.conversationId), m)
    this.dirtyMessages.add(m.conversationId)
    this.schedule()
  }

  /** Removes a message and everything after it. */
  truncateFrom(conversationId: string, messageId: string): Message[] {
    const list = this.messagesOf(conversationId)
    const i = list.findIndex((m) => m.id === messageId)
    if (i < 0) return []
    const removed = list.splice(i)
    this.dirtyMessages.add(conversationId)
    this.schedule()
    return removed
  }

  // ---- versions of a turn -----------------------------------------------------
  // Editing a message or regenerating a reply keeps the old turn and what followed
  // it. For each group, `tails[i]` holds version i's messages; the version on
  // screen is in the transcript itself, so its slot is null.

  private variants = new Map<string, Record<string, VariantGroup>>()
  private variantsFile(conversationId: string) {
    return join(this.dir, 'messages', `${conversationId}.variants.json`)
  }
  private variantsOf(conversationId: string): Record<string, VariantGroup> {
    let v = this.variants.get(conversationId)
    if (!v) {
      v = readJson<Record<string, VariantGroup>>(this.variantsFile(conversationId)) ?? {}
      this.variants.set(conversationId, v)
    }
    return v
  }
  private saveVariants(conversationId: string) {
    this.dirtyVariants.add(conversationId)
    this.schedule()
  }

  /**
   * Sets aside a user message and everything after it as one version of that
   * turn, and makes room for a new one. Returns what was removed from the
   * transcript and the version info for the new message.
   */
  archiveFrom(conversationId: string, messageId: string): { removed: Message[]; variant?: Message['variant'] } {
    const removed = this.truncateFrom(conversationId, messageId)
    const head = removed[0]
    if (!head || head.role !== 'user') return { removed }
    const group = head.variant?.group ?? head.id
    const all = this.variantsOf(conversationId)
    const g = (all[group] ??= { tails: [null], active: 0 })
    g.tails[g.active] = removed
    g.tails.push(null)
    g.active = g.tails.length - 1
    this.saveVariants(conversationId)
    return { removed, variant: { group, index: g.active, count: g.tails.length } }
  }

  /** Swaps the version of a turn on screen for another one. */
  switchVariant(conversationId: string, group: string, index: number): { removed: Message[]; restored: Message[] } | undefined {
    const g = this.variantsOf(conversationId)[group]
    const list = this.messagesOf(conversationId)
    const head = list.find((m) => m.role === 'user' && (m.variant?.group ?? m.id) === group)
    const wanted = g?.tails[index]
    if (!g || !head || index === g.active || !wanted) return undefined
    const removed = this.truncateFrom(conversationId, head.id)
    g.tails[g.active] = removed
    g.tails[index] = null
    g.active = index
    const restored = wanted.map((m, i) => (i === 0 ? { ...m, variant: { group, index, count: g.tails.length } } : m))
    list.push(...restored)
    this.saveVariants(conversationId)
    this.dirtyMessages.add(conversationId)
    this.schedule()
    return { removed, restored }
  }

  // ---- connectors ---------------------------------------------------------
  get connectors(): Connector[] {
    return this.state.connectors ?? []
  }
  putConnector(c: Connector): void {
    this.state.connectors = this.connectors
    upsert(this.state.connectors, c)
    this.touch()
  }
  removeConnector(id: string): void {
    this.state.connectors = this.connectors.filter((c) => c.id !== id)
    this.touch()
  }

  // ---- routines -----------------------------------------------------------
  get routines(): Routine[] {
    return this.state.routines
  }
  putRoutine(r: Routine): void {
    upsert(this.state.routines, r)
    this.touch()
  }
  removeRoutine(id: string): void {
    this.state.routines = this.state.routines.filter((r) => r.id !== id)
    this.touch()
  }

  // ---- settings -----------------------------------------------------------
  get settings(): AppSettings {
    return this.state.settings
  }
  patchSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...patch }
    this.touch()
    return this.state.settings
  }
  allBackendSettings(): Record<string, Record<string, string>> {
    return this.state.backendSettings
  }
  backendSettings(id: string): Record<string, string> {
    return this.state.backendSettings[id] ?? {}
  }
  setBackendSetting(id: string, key: string, value: string): void {
    const s = (this.state.backendSettings[id] ??= {})
    if (value) s[key] = value
    else delete s[key]
    this.touch()
  }

  // ---- persistence --------------------------------------------------------
  private touch(): void {
    this.dirtyState = true
    this.schedule()
  }
  private schedule(): void {
    this.timer ??= setTimeout(() => this.flush(), 400)
  }
  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.dirtyState) {
      writeAtomic(join(this.dir, 'state.json'), this.state)
      this.dirtyState = false
    }
    for (const id of this.dirtyMessages) {
      if (this.messages.has(id)) writeAtomic(join(this.dir, 'messages', `${id}.json`), this.messages.get(id))
    }
    this.dirtyMessages.clear()
    for (const id of this.dirtyVariants) if (this.variants.has(id)) writeAtomic(this.variantsFile(id), this.variants.get(id))
    this.dirtyVariants.clear()
  }
}

interface VariantGroup {
  tails: (Message[] | null)[]
  active: number
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) list[i] = item
  else list.push(item)
}

/**
 * Reads a JSON file, falling back to the previous version (`.bak`) when the
 * file is missing or damaged. A damaged file is kept aside, never overwritten.
 */
function readJson<T>(file: string): T | undefined {
  const parse = (f: string): T | undefined => {
    if (!existsSync(f)) return undefined
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T
    } catch {
      renameSync(f, `${f}.corrupt-${Date.now()}`)
      return undefined
    }
  }
  return parse(file) ?? parse(`${file}.bak`)
}

/** Write to a temp file, flush it to disk, keep the previous version as `.bak`, then swap in. */
function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (existsSync(file)) renameSync(file, `${file}.bak`)
  renameSync(tmp, file)
}
