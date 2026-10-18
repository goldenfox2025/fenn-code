import { t } from '../../shared/i18n'

/** The provisional title a chat gets from its first message, before its first reply. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 28 ? line.slice(0, 28) + '…' : line || t('新对话')
}

/** Openings that say nothing about the topic: 「请帮我」「能不能」「Please」「Can you」… */
const OPENERS = /^(?:(?:请|麻烦|能不能|能否|可以|可不可以|你能|你可以|您能|您可以|帮忙|帮我|给我|替我|我想|我要|我需要|想请你)\s*)+|^(?:(?:please|can you|could you|would you|help me|i want to|i need to|i'd like to)\s+)+/i

/**
 * A chat's title, made locally from what the user wrote (no agent is asked): its first sentence
 * with a filler opening and closing punctuation taken off, kept short.
 */
export function localTitle(text: string): string {
  const line = text.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  let s = line.replace(/\s+/g, ' ').replace(OPENERS, '')
  // The first sentence, when it says enough on its own: 「周末去哪里爬山比较好？我在杭州」 → 「周末去哪里爬山比较好」.
  const sentence = /^(.+?)(?:[。！？!?]|\.\s)/u.exec(s)?.[1]
  if (sentence && [...sentence.trim()].length >= 4) s = sentence
  s = s.replace(/[\s,，。.!！?？~～:：;；、]+$/u, '').trim()
  if (!s) s = line.replace(/[\s。.!！?？]+$/u, '')
  if (/^[a-z]/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  const chars = [...s]
  // About what Claude's titles hold: some 20 CJK characters, or 40 Latin ones.
  const max = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s) ? 20 : 40
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s
}
