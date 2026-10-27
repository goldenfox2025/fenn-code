import { useMemo } from 'react'
import type { Conversation } from '@shared/model'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { LibraryIndex } from './LibraryIndex'

export function ChatLibrary({ conversation, onBrowseChange }: { conversation: Conversation; onBrowseChange: (browsing: boolean) => void }) {
  const owner = conversation.parentId ?? conversation.id
  const cwd = useApp(s => s.conversations.find(c => c.id === owner)?.cwd)
  const language = useApp(s => s.settings.language)
  const sources = useMemo(() => [{ key: 'workspace', id: owner, label: t('工作文件'), chooseFolder: async () => {
    const cwd = await api().pickFolder()
    if (cwd) await api().updateConversation(owner, { cwd })
  } }], [owner, cwd, language])
  return <LibraryIndex sources={sources} conversationId={conversation.id} className="chat-library" onBrowseChange={onBrowseChange} />
}
