import { useMemo } from 'react'
import type { Conversation } from '@shared/model'
import { backgroundTasks } from '@shared/backgroundTasks'
import { useApp } from '../../store'

export function useBackgroundTasks(conv: Conversation) {
  const conversations = useApp(s => s.conversations)
  return useMemo(() => backgroundTasks(conv, conversations), [conv, conversations])
}

export function useRunning(conv: Conversation): number {
  return useApp(s => backgroundTasks(conv, s.conversations).filter(task => task.state === 'running').length)
}
