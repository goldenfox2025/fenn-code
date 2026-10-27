/**
 * JSON-file persistence: one state file for metadata, one file per
 * conversation for its messages. Writes are debounced and atomic.
 */
import { demoAgentEnabled } from '../demo'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../../shared/i18n'
import { remapMovedPaths, type MovedFolder } from './movedFolders'
import { normalizeTheme, type AppSettings, type Connector, type Conversation, type Message, type PeerMessage, type Project, type Routine, type BoardWidget } from '../../shared/model'

interface StateFile {
  version: 1
  projects: Project[]
  conversations: Conversation[]
  routines: Routine[]
  boardWidgets?: BoardWidget[]
  connectors?: Connector[]
  peerMessages?: PeerMessage[]
  settings: AppSettings
  backendSettings: Record<string, Record<string, string>>
}

export const DEFAULT_SETTINGS: AppSettings = {
  // The core resolves an unset default against installed agents before the first snapshot.
  defaultBackendId: demoAgentEnabled() ? 'mock' : '',
  theme: 'system',
  // A login name (root, j.doe) is not what people want to be called; ask in settings instead.
  userName: '',
  notifications: true
}


export class Store {
  private state: StateFile
  // Lookups by id, kept in step with the lists (the lists stay the order things were added in).
  private projectIndex = new Map<string, Project>()
  private conversationIndex = new Map<string, Conversation>()
  private messages = new Map<string, Message[]>()
  private dirtyState = false
  private dirtyMessages = new Set<string>()
  private dirtyVariants = new Set<string>()
  private timer?: NodeJS.Timeout
  /** How a file is saved (tests stand in for a disk that refuses). */
  writeFile: (file: string, data: unknown, durable?: boolean) => void = writeAtomic
  /** Conversations whose turn was cut off by the last shutdown or crash. */
  readonly interrupted: string[] = []

  /** `moved`: the app's former data folders, whose saved paths now point into the new one. */
  constructor(
    readonly dir: string,
    private readonly moved: MovedFolder[] = []
  ) {
    mkdirSync(join(dir, 'messages'), { recursive: true })
    const loaded = readJson<StateFile>(join(dir, 'state.json'))
    if (remapMovedPaths(loaded, moved)) this.touch()
    this.state = {
      version: 1,
      projects: loaded?.projects ?? [],
      conversations: loaded?.conversations ?? [],
      routines: loaded?.routines ?? [],
      boardWidgets: loaded?.boardWidgets ?? [],
      connectors: loaded?.connectors ?? [],
      peerMessages: loaded?.peerMessages ?? [],
      settings: normalizeTheme({ ...DEFAULT_SETTINGS, ...loaded?.settings }),
      backendSettings: loaded?.backendSettings ?? {}
    }
    if (loaded?.settings && ('glass' in loaded.settings || loaded.settings.theme !== this.state.settings.theme)) this.touch()
    for (const p of this.state.projects) this.projectIndex.set(p.id, p)
    for (const c of this.state.conversations) this.conversationIndex.set(c.id, c)
    // Data from before the first-run guide existed: the user is already set up, so don't guide them again.
    const s = this.state
    // Home widgets were retired. Keep saved cards for data compatibility, but
    // never keep spending model requests to refresh an invisible widget.
    for (const routine of s.routines) if (routine.widgetId && routine.enabled) {
      routine.enabled = false
      routine.nextRunAt = undefined
      this.dirtyState = true
    }
    if (loaded && loaded.settings?.onboarded === undefined && (s.conversations.length || s.projects.length || s.settings.userName)) {
      s.settings.onboarded = true
      this.dirtyState = true
    }
    // Anything that was mid-turn when the app quit is no longer running.
    for (const c of this.state.conversations) {
      // A turn that was running when the app last quit was cut off.
      if (c.status === 'working') this.interrupted.push(c.id)
      if (c.status === 'working' || (c.status === 'waiting' && c.kind !== 'thread')) c.status = 'idle'
      delete c.queued
    }
  }

  // ---- projects -----------------------------------------------------------
  get projects(): Project[] {
    return this.state.projects
  }
  project(id: string | undefined): Project | undefined {
    return id ? this.projectIndex.get(id) : undefined
  }
  /** The project, or an error the user can read. */
  requireProject(id: string | undefined): Project {
    const p = this.project(id)
    if (!p) throw new Error(t('项目不存在或已被删除'))
    return p
  }
  putProject(p: Project): void {
    upsert(this.state.projects, p)
    this.projectIndex.set(p.id, p)
    this.touch()
  }
  removeProject(id: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== id)
    this.projectIndex.delete(id)
    this.touch()
  }

  // ---- conversations ------------------------------------------------------
  get conversations(): Conversation[] {
    return this.state.conversations
  }
  conversation(id: string | undefined): Conversation | undefined {
    return id ? this.conversationIndex.get(id) : undefined
  }
  /** The conversation, or an error the user can read. */
  requireConversation(id: string | undefined): Conversation {
    const c = this.conversation(id)
    if (!c) throw new Error(t('对话不存在或已被删除'))
    return c
  }
  putConversation(c: Conversation): void {
    upsert(this.state.conversations, c)
    this.conversationIndex.set(c.id, c)
    this.touch()
  }
  removeConversation(id: string): void {
    this.state.conversations = this.state.conversations.filter((c) => c.id !== id)
    this.conversationIndex.delete(id)
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
      if (remapMovedPaths(list, this.moved)) {
        this.dirtyMessages.add(conversationId)
        this.schedule()
      }
      // A reply cut off by a quit: drop it if nothing was said yet (unless a thread card hangs on it,
      // or it is the chat's last message, where it shows 已中断 with 重试).
      if (list.some((m) => m.state === 'streaming' && !m.blocks.length)) {
        const anchors = new Set(this.conversations.map((c) => c.anchorMessageId).filter(Boolean))
        const last = list[list.length - 1]
        list = list.filter((m) => !(m.state === 'streaming' && !m.blocks.length && !anchors.has(m.id) && m !== last))
      }
      for (const m of list)
        if (m.state === 'streaming') {
          m.state = 'cancelled'
          m.interrupted = true
        }
      this.messages.set(conversationId, list)
    }
    return list
  }
  /** A conversation's messages without keeping them loaded (for a pass over every chat). */
  peekMessages(conversationId: string): Message[] {
    const cached = this.messages.get(conversationId)
    if (cached) return cached
    const list = readJson<Message[]>(join(this.dir, 'messages', `${conversationId}.json`)) ?? []
    remapMovedPaths(list, this.moved)
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
      remapMovedPaths(v, this.moved)
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

  // ---- messages between threads ----------------------------------------------
  get peerMessages(): PeerMessage[] {
    return this.state.peerMessages ?? []
  }
  putPeerMessage(m: PeerMessage): void {
    this.state.peerMessages = this.peerMessages
    upsert(this.state.peerMessages, m)
    // Settled ones are kept a while for their cards, then dropped.
    if (this.state.peerMessages.length > 500) {
      const settled = this.state.peerMessages.filter((x) => x.state !== 'pending')
      const drop = new Set(settled.slice(0, this.state.peerMessages.length - 500).map((x) => x.id))
      this.state.peerMessages = this.state.peerMessages.filter((x) => !drop.has(x.id))
    }
    this.touch()
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

  // ---- home board ---------------------------------------------------------
  get boardWidgets(): BoardWidget[] {
    return (this.state.boardWidgets ??= [])
  }

  // ---- settings -----------------------------------------------------------
  get settings(): AppSettings {
    return this.state.settings
  }
  patchSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = normalizeTheme({ ...this.state.settings, ...patch })
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
    if (this.frozen) return
    this.timer ??= setTimeout(() => this.flush(), 400)
  }
  private frozen = false
  /**
   * Saves now and keeps what is on disk from then on. Quitting stops the agents after this, and the
   * turns they were running must stay saved as cut off (so the next launch says 已中断), not as errors.
   */
  freeze(): void {
    this.flush()
    this.frozen = true
  }
  /**
   * Saves what changed. Never throws: a file that can't be written (e.g. Windows keeps refusing
   * with EPERM while another program holds it) is logged, stays in memory and marked unsaved,
   * and goes with the next save, or a retry a few seconds on.
   */
  flush(): void {
    if (this.frozen) return
    clearTimeout(this.timer)
    this.timer = undefined
    let failed = false
    const save = (file: string, data: unknown, durable?: boolean): boolean => {
      try {
        this.writeFile(file, data, durable)
        return true
      } catch (e) {
        failed = true
        console.error(`[store] could not save ${file}:`, e instanceof Error ? e.message : e)
        return false
      }
    }
    if (this.dirtyState && save(join(this.dir, 'state.json'), this.state)) this.dirtyState = false
    for (const id of [...this.dirtyMessages]) {
      const list = this.messages.get(id)
      // While a reply streams the file is rewritten every 400 ms: still atomic, but forced to disk only once it settles.
      if (!list || save(join(this.dir, 'messages', `${id}.json`), list, !list.some((m) => m.state === 'streaming'))) this.dirtyMessages.delete(id)
    }
    for (const id of [...this.dirtyVariants])
      if (!this.variants.has(id) || save(this.variantsFile(id), this.variants.get(id))) this.dirtyVariants.delete(id)
    if (failed) {
      this.timer = setTimeout(() => this.flush(), 5000)
      this.timer.unref?.()
    }
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
function writeAtomic(file: string, data: unknown, durable = true): void {
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(data))
    if (durable) fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (existsSync(file)) renameRetrying(file, `${file}.bak`)
  renameRetrying(tmp, file)
}

/** On Windows a virus scanner or the indexer may hold a file for a moment just after it was written: try again briefly. */
function renameRetrying(from: string, to: string): void {
  for (let i = 1; ; i++) {
    try {
      return renameSync(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * i)
    }
  }
}
