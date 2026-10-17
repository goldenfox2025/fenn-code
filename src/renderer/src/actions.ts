/**
 * What the user can do to a chat or project, the same from every menu and page:
 * where a conversation opens, and deleting with one confirmation and one wording.
 */
import type { Conversation, Project } from '@shared/model'
import { t } from './i18n'
import { api, toastError, useApp } from './store'
import { routeFor } from './routes'

export { routeFor }
import { confirmDialog } from './components/Modal'

export function openConversation(c: Pick<Conversation, 'id' | 'kind' | 'projectId'>): void {
  useApp.getState().navigate(routeFor(c))
}

/** Asks, then deletes a chat (its sub-chats stay, as chats of their own); leaves its page if it is open. */
export async function deleteChat(c: Conversation): Promise<boolean> {
  const s = useApp.getState()
  const kept = s.conversations.some((x) => x.parentId === c.id) ? ' ' + t('它的子对话会保留，成为独立的对话。') : ''
  if (!(await confirmDialog(t('删除「{0}」？此操作无法撤销。', c.title) + kept))) return false
  try {
    await api().deleteConversation(c.id)
  } catch (e) {
    toastError(e)
    return false
  }
  const route = useApp.getState().route
  if (route.view === 'chat' && route.conversationId === c.id) useApp.getState().navigate({ view: 'home' })
  return true
}

/** Asks, then deletes a project and its threads (its plain chats stay); leaves its page if it is open. */
export async function deleteProject(p: Project): Promise<boolean> {
  if (!(await confirmDialog(t('删除项目「{0}」及其所有讨论串？项目内的普通对话会保留。', p.name)))) return false
  try {
    await api().deleteProject(p.id)
  } catch (e) {
    toastError(e)
    return false
  }
  const route = useApp.getState().route
  if (route.view === 'project' && route.projectId === p.id) useApp.getState().navigate({ view: 'projects' })
  return true
}
