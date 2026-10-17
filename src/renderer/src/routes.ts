import type { Conversation } from '@shared/model'
import type { Route } from './store'

/** Where a conversation is shown: a thread in its project, a project chat as the project, a chat on its own. */
export function routeFor(c: Pick<Conversation, 'id' | 'kind' | 'projectId'>): Route {
  if (c.kind === 'thread' && c.projectId) return { view: 'project', projectId: c.projectId, threadId: c.id }
  if (c.kind === 'project' && c.projectId) return { view: 'project', projectId: c.projectId }
  return { view: 'chat', conversationId: c.id }
}
