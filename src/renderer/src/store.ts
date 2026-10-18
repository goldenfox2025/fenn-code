import { useEffect } from 'react'
import { create } from 'zustand'
import type { AccountStatus, BackendSummary, PermissionRequest } from '@shared/contract'
import { backendAvailable } from '@shared/backendAvailability'
import { errorText, plainError } from '@shared/errors'
import { routeFor } from './routes'
import type { AppEvent, AppSettings, BoardWidget, Conversation, Message, FennApi, PeerMessage, Project, Routine } from '@shared/model'

declare global {
  interface Window {
    fenn: FennApi
  }
}

export const api = (): FennApi => window.fenn

export type Route =
  | { view: 'home'; folder?: string }
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
  /** Cards agents put on the home board. */
  boardWidgets: BoardWidget[]
  /** Messages between threads (see PeerMessage). */
  peerMessages: PeerMessage[]
  /** Bumped when a project's memory changes, so its memory view reloads. */
  memoryVersion: Record<string, number>
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
  /** A file opened from a chat (an output card, a link), shown beside it. */
  fileView: { path: string; conversationId?: string } | null
  /** The files / background pane beside a chat, if open (stays open from chat to chat). */
  sidePane: 'files' | 'background' | null
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
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
/** At most this many notices show; a newer one pushes out the oldest. */
const TOAST_MAX = 3

/** Takes a notice away (its time is up, or the user closed it). */
export function dismissToast(id: number): void {
  clearTimeout(toastTimers.get(id))
  toastTimers.delete(id)
  useApp.setState({ toasts: useApp.getState().toasts.filter((t) => t.id !== id) })
}

export const useApp = create<State>((set, get) => ({
  ready: false,
  projects: [],
  conversations: [],
  routines: [],
  boardWidgets: [],
  peerMessages: [],
  memoryVersion: {},
  settings: { defaultBackendId: '', theme: 'system', userName: '' },
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
  fileView: null,
  sidePane: null,
  focusMessage: null,

  async init() {
    const snap = await api().snapshot()
    set({ ...snap, peerMessages: snap.peerMessages ?? [], boardWidgets: snap.boardWidgets ?? [], ready: true })
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
    case 'memory-changed':
      return set({ memoryVersion: { ...s.memoryVersion, [e.projectId]: (s.memoryVersion[e.projectId] ?? 0) + 1 } })
    case 'routine':
      return set({ routines: upsert(s.routines, e.routine) })
    case 'peer-message':
      return set({ peerMessages: upsert(s.peerMessages, e.message) })
    case 'routine-removed':
      return set({ routines: s.routines.filter((r) => r.id !== e.id) })
    case 'board-widget':
      return set({ boardWidgets: upsert(s.boardWidgets, e.widget) })
    case 'board-widget-removed':
      return set({ boardWidgets: s.boardWidgets.filter((w) => w.id !== e.id) })
    case 'settings':
      return set({ settings: e.settings })
    case 'backends':
      accountGeneration++
      accountChecks.clear()
      return set({ backends: e.backends, accounts: {} })
    case 'permission':
      return set({ permissions: [...s.permissions, { conversationId: e.conversationId, request: e.request }] })
    case 'permission-resolved':
      return set({ permissions: s.permissions.filter((p) => p.request.requestId !== e.requestId) })
    case 'open-conversation': {
      const c = s.conversations.find((x) => x.id === e.conversationId)
      if (!c) return
      return s.navigate(routeFor(c))
    }
    case 'backend-upgrade':
      window.dispatchEvent(new CustomEvent('oc-upgrade-line', { detail: e }))
      return
    case 'toast': {
      // The same notice again (a save retried, a click repeated) shows once, for longer.
      const same = s.toasts.find((t) => t.level === e.level && t.text === e.text)
      const id = same?.id ?? ++toastSeq
      if (!same) {
        const kept = s.toasts.slice(-(TOAST_MAX - 1))
        for (const t of s.toasts) if (!kept.includes(t)) clearTimeout(toastTimers.get(t.id))
        set({ toasts: [...kept, { id, level: e.level, text: e.text }] })
      }
      clearTimeout(toastTimers.get(id))
      toastTimers.set(id, setTimeout(() => (get().toasts.some((t) => t.id === id) ? dismissToast(id) : undefined), e.level === 'error' ? 8000 : 4000))
      return
    }
  }
}

const accountChecks = new Map<string, Promise<AccountStatus>>()
let accountGeneration = 0

/** Asks a backend for its install and sign-in state, unless it was checked within maxAgeMs. */
export function refreshAccount(backendId: string, maxAgeMs = 0): Promise<AccountStatus> {
  const known = useApp.getState().accounts[backendId]
  if (known && Date.now() - known.at < maxAgeMs) return Promise.resolve(known)
  let p = accountChecks.get(backendId)
  if (!p) {
    const generation = accountGeneration
    p = api()
      .backendAccount(backendId)
      .catch(() => ({}) as AccountStatus)
      .then((a) => {
        if (generation === accountGeneration) useApp.setState((s) => ({ accounts: { ...s.accounts, [backendId]: { ...a, at: Date.now() } } }))
        return a
      })
      .finally(() => { if (accountChecks.get(backendId) === p) accountChecks.delete(backendId) })
    accountChecks.set(backendId, p)
  }
  return p
}

export function toast(text: string, level: 'info' | 'error' = 'info'): void {
  applyEvent({ type: 'toast', level, text }, useApp.setState, useApp.getState)
}

/** Shows what went wrong, as the core said it. Fits straight into `.catch(toastError)`. */
/** Opens a file in the app, beside the chat: editable in a working folder, read only elsewhere. */
export function openFileInApp(path: string, conversationId?: string): void {
  useApp.setState({ fileView: { path, conversationId }, page: null })
}

export function toastError(e: unknown): void {
  toast(plainError(errorText(e)), 'error')
}

/**
 * Backends that are installed and signed in, as far as they report it, plus `keep`
 * (the one already chosen), so a form never offers an agent that can't answer.
 */
export function useUsableBackends(keep?: string): BackendSummary[] {
  const backends = useApp((s) => s.backends)
  const accounts = useApp((s) => s.accounts)
  useEffect(() => {
    for (const b of backends) if (b.account) void refreshAccount(b.id, 60_000)
  }, [backends])
  return backends.filter((b) => b.id === keep || backendAvailable(b, accounts[b.id]))
}
