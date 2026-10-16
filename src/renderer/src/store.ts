import { create } from 'zustand'
import type { AccountStatus, BackendSummary, PermissionRequest } from '@shared/contract'
import type { AppEvent, AppSettings, Conversation, Message, AncoraApi, Project, Routine } from '@shared/model'

declare global {
  interface Window {
    ancora: AncoraApi
  }
}

export const api = (): AncoraApi => window.ancora

export type Route =
  | { view: 'home'; projectId?: string }
  | { view: 'chat'; conversationId: string }
  | { view: 'project'; projectId: string; threadId?: string; overview?: boolean }
  | { view: 'projects' }
  | { view: 'routines' }
  | { view: 'chats' }

interface PendingPermission {
  conversationId?: string
  request: PermissionRequest
}

interface State {
  ready: boolean
  projects: Project[]
  conversations: Conversation[]
  routines: Routine[]
  settings: AppSettings
  backends: BackendSummary[]
  /** Each backend's install and sign-in state, as last checked (see refreshAccount). */
  accounts: Record<string, AccountStatus & { at: number }>
  platform: string
  messages: Record<string, Message[]>
  permissions: PendingPermission[]
  toasts: { id: number; level: 'info' | 'error'; text: string }[]
  route: Route
  history: Route[]
  future: Route[]
  sidebarOpen: boolean
  settingsOpen: boolean | string
  search: string
  /** The published page open beside the conversation. */
  page: { id: string; version?: number } | null
  /** A message to scroll to and flash once its conversation is shown (from search). */
  focusMessage: string | null

  init(): Promise<void>
  navigate(r: Route): void
  back(): void
  forward(): void
  loadMessages(conversationId: string): Promise<void>
  set(patch: Partial<State>): void
}

let toastSeq = 0

export const useApp = create<State>((set, get) => ({
  ready: false,
  projects: [],
  conversations: [],
  routines: [],
  settings: { defaultBackendId: '', theme: 'system', userName: '', autoAssignChats: true },
  backends: [],
  accounts: {},
  platform: 'linux',
  messages: {},
  permissions: [],
  toasts: [],
  route: { view: 'home' },
  history: [],
  future: [],
  sidebarOpen: true,
  settingsOpen: false,
  search: '',
  page: null,
  focusMessage: null,

  async init() {
    const snap = await api().snapshot()
    set({ ...snap, ready: true })
    api().onEvent((e) => applyEvent(e, set, get))
  },

  navigate(r) {
    const cur = get().route
    if (JSON.stringify(cur) === JSON.stringify(r)) return
    set({ route: r, history: [...get().history, cur].slice(-50), future: [] })
  },
  back() {
    const h = get().history
    if (!h.length) return
    set({ route: h[h.length - 1], history: h.slice(0, -1), future: [get().route, ...get().future] })
  },
  forward() {
    const f = get().future
    if (!f.length) return
    set({ route: f[0], future: f.slice(1), history: [...get().history, get().route] })
  },

  async loadMessages(conversationId) {
    if (get().messages[conversationId]) return
    const list = await api().messages(conversationId)
    set({ messages: { ...get().messages, [conversationId]: list } })
  },

  set(patch) {
    set(patch)
  }
}))

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

function applyEvent(e: AppEvent, set: (p: Partial<State>) => void, get: () => State): void {
  const s = get()
  switch (e.type) {
    case 'project':
      return set({ projects: upsert(s.projects, e.project) })
    case 'project-removed':
      return set({ projects: s.projects.filter((p) => p.id !== e.id) })
    case 'conversation':
      return set({ conversations: upsert(s.conversations, e.conversation) })
    case 'conversation-removed':
      return set({ conversations: s.conversations.filter((c) => c.id !== e.id) })
    case 'message': {
      const list = s.messages[e.message.conversationId]
      if (!list) return // not loaded yet; will be fetched on open
      // A page just published in the conversation on screen opens beside it, like Claude's artifacts.
      const before = list.find((m) => m.id === e.message.id)?.blocks.length ?? 0
      const fresh = e.message.blocks.slice(before).find((b) => b.type === 'artifact')
      const r = s.route
      const onScreen =
        (r.view === 'chat' && r.conversationId === e.message.conversationId) ||
        (r.view === 'project' &&
          (r.threadId === e.message.conversationId ||
            s.projects.find((p) => p.id === r.projectId)?.conversationId === e.message.conversationId))
      return set({
        messages: { ...s.messages, [e.message.conversationId]: upsert(list, e.message) },
        ...(fresh && fresh.type === 'artifact' && onScreen ? { page: { id: fresh.artifactId, version: fresh.version } } : {})
      })
    }
    case 'message-removed': {
      const list = s.messages[e.conversationId]
      if (!list) return
      return set({ messages: { ...s.messages, [e.conversationId]: list.filter((m) => m.id !== e.id) } })
    }
    case 'routine':
      return set({ routines: upsert(s.routines, e.routine) })
    case 'routine-removed':
      return set({ routines: s.routines.filter((r) => r.id !== e.id) })
    case 'settings':
      return set({ settings: e.settings })
    case 'backends':
      return set({ backends: e.backends })
    case 'permission':
      return set({ permissions: [...s.permissions, { conversationId: e.conversationId, request: e.request }] })
    case 'permission-resolved':
      return set({ permissions: s.permissions.filter((p) => p.request.requestId !== e.requestId) })
    case 'open-conversation': {
      const c = s.conversations.find((x) => x.id === e.conversationId)
      if (!c) return
      if (c.kind === 'thread' && c.projectId) return s.navigate({ view: 'project', projectId: c.projectId, threadId: c.id })
      if (c.kind === 'project' && c.projectId) return s.navigate({ view: 'project', projectId: c.projectId })
      return s.navigate({ view: 'chat', conversationId: c.id })
    }
    case 'backend-upgrade':
      window.dispatchEvent(new CustomEvent('oc-upgrade-line', { detail: e }))
      return
    case 'toast': {
      const id = ++toastSeq
      set({ toasts: [...s.toasts, { id, level: e.level, text: e.text }] })
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 5000)
      return
    }
  }
}

const accountChecks = new Map<string, Promise<AccountStatus>>()

/** Asks a backend for its install and sign-in state, unless it was checked within maxAgeMs. */
export function refreshAccount(backendId: string, maxAgeMs = 0): Promise<AccountStatus> {
  const known = useApp.getState().accounts[backendId]
  if (known && Date.now() - known.at < maxAgeMs) return Promise.resolve(known)
  let p = accountChecks.get(backendId)
  if (!p) {
    p = api()
      .backendAccount(backendId)
      .catch(() => ({}) as AccountStatus)
      .then((a) => {
        useApp.setState((s) => ({ accounts: { ...s.accounts, [backendId]: { ...a, at: Date.now() } } }))
        return a
      })
      .finally(() => accountChecks.delete(backendId))
    accountChecks.set(backendId, p)
  }
  return p
}

export function toast(text: string, level: 'info' | 'error' = 'info'): void {
  applyEvent({ type: 'toast', level, text }, useApp.setState, useApp.getState)
}
