/**
 * What the user can do to a chat or project, the same from every menu and page:
 * where a conversation opens, and deleting with one confirmation and one wording.
 */
import type { Conversation, Project } from '@shared/model'
import { t } from './i18n'
import { api, toast, toastError, useApp } from './store'
import { routeFor } from './routes'

export { routeFor }
import { deleteItemsDialog } from './components/DeleteItemsDialog'

export function openConversation(c: Pick<Conversation, 'id' | 'kind' | 'projectId'>): void {
  useApp.getState().navigate(routeFor(c))
}

/** Asks, then deletes a chat (its sub-chats stay, as chats of their own); leaves its page if it is open. */
export async function deleteChat(c: Conversation): Promise<boolean> {
  try {
    if (!(await deleteItemsDialog([{ kind: 'conversation', id: c.id }]))) return false
  } catch (e) {
    toastError(e)
    return false
  }
  const route = useApp.getState().route
  if (route.view === 'chat' && route.conversationId === c.id) useApp.getState().navigate({ view: 'home' })
  if (route.view === 'project' && route.threadId === c.id) useApp.getState().navigate({ view: 'project', projectId: route.projectId })
  return true
}

/** Asks, then deletes a project and its threads (its plain chats stay); leaves its page if it is open. */
export async function deleteProject(p: Project): Promise<boolean> {
  try {
    if (!(await deleteItemsDialog([{ kind: 'project', id: p.id }]))) return false
  } catch (e) {
    toastError(e)
    return false
  }
  const route = useApp.getState().route
  if (route.view === 'project' && route.projectId === p.id) useApp.getState().navigate({ view: 'projects' })
  return true
}

export async function deleteChats(conversations: Conversation[]): Promise<boolean> {
  try { return await deleteItemsDialog(conversations.map(conversation => ({ kind: 'conversation', id: conversation.id }))) }
  catch (error) { toastError(error); return false }
}

/** Opens a file or folder with the system (or shows it in the file manager); says so when it can't. */
export async function openInFileManager(path: string, reveal?: boolean): Promise<void> {
  try {
    const r = await api().openOutput(path, reveal)
    if (!r.ok) toast(r.error ?? t('打不开这个文件夹'), 'error')
  } catch (e) {
    toastError(e)
  }
}
