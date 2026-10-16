import { t } from '../../shared/i18n'

/** The provisional title a chat gets from its first message, before an agent names it. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ')
  return line.length > 28 ? line.slice(0, 28) + '…' : line || t('新对话')
}
