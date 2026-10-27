import type { BackgroundCommand, Conversation } from './model'

export type BackgroundTaskState = 'running' | 'waiting' | 'failed' | 'done' | 'ended' | 'idle'
interface TaskBase { key: string; ownerId: string; title: string; state: BackgroundTaskState; at: number }
export type BackgroundTask = TaskBase & (
  | { kind: 'conversation'; conversation: Conversation }
  | { kind: 'command'; command: BackgroundCommand }
)

export const taskNeedsAttention = (task: BackgroundTask) => task.state === 'failed' || task.state === 'waiting'
export const taskIsFinished = (task: BackgroundTask) => ['done', 'ended', 'idle', 'failed'].includes(task.state)

/** The list and its running badge must use the same scope. Command IDs belong
 * to their owning session, so equal IDs in parent/child sessions remain distinct. */
export function backgroundTasks(current: Conversation, conversations: Conversation[]): BackgroundTask[] {
  const conv = conversations.find(c => c.id === current.id) ?? current
  const rootId = conv.parentId ?? conv.id
  const root = conversations.find(c => c.id === rootId) ?? conv
  const children: BackgroundTask[] = conversations.filter(c => c.parentId === rootId).map(c => ({
    key: `conversation:${c.id}`, ownerId: c.id, kind: 'conversation', title: c.title, at: c.updatedAt, conversation: c,
    state: c.status === 'working' ? 'running' : c.status === 'error' ? 'failed' : c.resolved || c.status === 'done' ? 'done' : c.status === 'waiting' || c.needsUser ? 'waiting' : 'idle'
  }))
  const owners = root.id === conv.id ? [root] : [root, conv]
  const commands: BackgroundTask[] = owners.flatMap(owner => (owner.background ?? []).map(command => ({
    key: `command:${owner.id}:${command.id}:${command.startedAt}`, ownerId: owner.id, kind: 'command' as const,
    title: command.title?.trim() || command.command, at: command.startedAt, command,
    state: command.endedAt == null ? 'running' as const : command.failed || (command.exitCode != null && command.exitCode !== 0) ? 'failed' as const : command.exitCode === 0 ? 'done' as const : 'ended' as const
  })))
  return [...children, ...commands].sort((a, b) => Number(taskNeedsAttention(b)) - Number(taskNeedsAttention(a)) || b.at - a.at || a.key.localeCompare(b.key))
}

export const canStopTask = (task: BackgroundTask) => task.state === 'running' && (task.kind === 'conversation' || !task.command.managed)
