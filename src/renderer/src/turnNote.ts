import { classifyError, isFriendly, limitResetIn } from '@shared/errors'
import type { Message } from '@shared/model'
import { t } from './i18n'

/**
 * A quiet line under a turn that ended without its full answer, in one style for every
 * case (TurnNote in Transcript.tsx): stopped by the user, cut off by a restart or by a
 * switch of agent, or paused by a usage limit that lifts by itself. None of these is a
 * failure the user must fix, so none is drawn as an error.
 */
export interface TurnNoteView {
  kind: 'stopped' | 'interrupted' | 'switched' | 'limit'
  text: string
  /** Offers 重试 beside the note. */
  retry: boolean
  /** The agent's own words, on hover. */
  tip?: string
}

/** 「Claude 的用量到上限了，56 秒后恢复，到时点「重试」。」 */
export function limitSentence(agent: string, raw: string): string {
  const wait = limitResetIn(raw)
  return wait ? t('{0} 的用量到上限了，{1}后恢复，到时点「重试」。', agent, wait) : t('{0} 的用量到上限了，恢复后点「重试」。', agent)
}

/** The note a reply ends with, or null when it ended normally or failed in a way the error bar explains. */
export function turnNote(
  m: Pick<Message, 'state' | 'interrupted' | 'switchedTo' | 'error'>,
  o: { agent: string; last?: boolean; busy?: boolean; resumes?: boolean }
): TurnNoteView | null {
  if (m.state === 'cancelled') {
    if (m.switchedTo) return { kind: 'switched', text: t('已中断：换成了 {0}', m.switchedTo), retry: false }
    if (m.interrupted)
      return { kind: 'interrupted', text: o.resumes ? t('因应用重启中断，已自动继续') : t('因应用重启中断'), retry: !!o.last && !o.resumes }
    return { kind: 'stopped', text: t('已停止'), retry: false }
  }
  const raw = m.error ?? ''
  if (m.state === 'error' && classifyError(raw) === 'limit' && !isFriendly(raw))
    return { kind: 'limit', text: limitSentence(o.agent, raw), retry: !!o.last && !o.busy, tip: raw }
  return null
}
