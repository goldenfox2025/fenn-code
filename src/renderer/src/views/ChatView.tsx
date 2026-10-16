import { useState } from 'react'
import { Download, FolderKanban, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { Composer } from '../components/Composer'
import { useMenu } from '../components/Menu'
import { PermissionPrompts } from '../components/Permission'
import { Transcript } from '../components/Transcript'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { confirmDialog } from '../components/Modal'
import { PlanLine } from '../components/PlanLine'
import { UsageButton } from '../components/Usage'

export function ChatView({ conversationId }: { conversationId: string }) {
  const conv = useApp((s) => s.conversations.find((c) => c.id === conversationId))
  const projects = useApp((s) => s.projects)
  const navigate = useApp((s) => s.navigate)
  const [menu, openMenu] = useMenu({ align: 'right' })
  if (!conv) return <div className="empty">{t('对话不存在或已被删除')}</div>
  const project = projects.find((p) => p.id === conv.projectId)

  return (
    <div className="center">
      <div className="chat-header">
        {project && (
          <>
            <button className="pill-btn" onClick={() => navigate({ view: 'project', projectId: project.id })}>
              <FolderKanban size={15} />
              {project.name}
            </button>
            <span className="muted">/</span>
          </>
        )}
        <EditableTitle conv={conv} />
        <span className="spacer" />
        <UsageButton usage={conv.usage} scope={t('本对话用量')} />
        <button
          className="icon-btn"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              {
                icon: conv.pinned ? <PinOff size={15} /> : <Pin size={15} />,
                label: conv.pinned ? t('取消置顶') : t('置顶'),
                onClick: () => api().updateConversation(conv.id, { pinned: !conv.pinned })
              },
              { heading: t('移到项目') },
              { label: t('不属于任何项目'), checked: !conv.projectId, onClick: () => api().updateConversation(conv.id, { projectId: undefined }) },
              ...projects.filter((p) => !p.archived || p.id === conv.projectId).map((p) => ({
                icon: <FolderKanban size={15} />,
                label: p.name,
                checked: p.id === conv.projectId,
                onClick: () => api().updateConversation(conv.id, { projectId: p.id })
              })),
              { separator: true },
              {
                icon: <Download size={15} />,
                label: t('导出为 Markdown'),
                onClick: () => void api().exportConversation(conv.id)
              },
              {
                icon: <Trash2 size={15} />,
                label: t('删除对话'),
                danger: true,
                onClick: async () => {
                  if (!(await confirmDialog(t('删除「{0}」？', conv.title)))) return
                  void api().deleteConversation(conv.id)
                  navigate({ view: 'home' })
                }
              }
            ])
          }
        >
          <MoreHorizontal size={17} />
        </button>
        {menu}
      </div>
      <PlanLine conv={conv} />
      <Transcript conversation={conv} />
      <PermissionPrompts conversationId={conv.id} />
      <Composer conversation={conv} autoFocus />
    </div>
  )
}

export function EditableTitle({ conv }: { conv: Conversation }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(conv.title)
  if (editing)
    return (
      <input
        className="chat-title-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (value.trim() && value !== conv.title) void api().updateConversation(conv.id, { title: value.trim() })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  return (
    <button
      className="chat-title"
      title={t('点击重命名')}
      onClick={() => {
        setValue(conv.title)
        setEditing(true)
      }}
    >
      {conv.title}
    </button>
  )
}
