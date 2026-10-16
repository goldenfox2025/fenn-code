import { useState } from 'react'
import { ChevronDown, ChevronRight, CornerUpLeft, Download, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { Composer } from '../components/Composer'
import { useMenu } from '../components/Menu'
import { PermissionPrompts } from '../components/Permission'
import { Transcript } from '../components/Transcript'
import { api, toast, useApp } from '../store'
import { t } from '../i18n'
import { confirmDialog } from '../components/Modal'
import { PlanLine } from '../components/PlanLine'
import { UsageButton } from '../components/Usage'

export function ChatView({ conversationId }: { conversationId: string }) {
  const conv = useApp((s) => s.conversations.find((c) => c.id === conversationId))
  const parent = useApp((s) => s.conversations.find((c) => c.id === conv?.parentId))
  const navigate = useApp((s) => s.navigate)
  const [menu, openMenu] = useMenu({ align: 'right' })
  if (!conv) return <div className="empty">{t('对话不存在或已被删除')}</div>
  const deleteChat = async () => {
    if (!(await confirmDialog(t('删除「{0}」？', conv.title)))) return
    try {
      await api().deleteConversation(conv.id)
      navigate({ view: 'home' })
    } catch (error) { toast(String(error), 'error') }
  }

  return (
    <div className="center">
      <div className="chat-header">
        <EditableTitle conv={conv} />
        {parent && (
          <button className="pill-btn back-to-parent" data-tip={parent.title} onClick={() => navigate({ view: 'chat', conversationId: parent.id })}>
            <CornerUpLeft size={14} />
            {t('回到主对话')}
          </button>
        )}
        <span className="spacer" />
        <UsageButton usage={conv.usage} timing={conv.timing} backendId={conv.backendId} scope={t('本对话用量')} creditsOnly />
        <button
          className="icon-btn"
          data-tip={t('更多对话操作')}
          aria-label={t('更多对话操作')}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              {
                icon: conv.pinned ? <PinOff size={15} /> : <Pin size={15} />,
                label: conv.pinned ? t('取消置顶') : t('置顶'),
                onClick: () => api().updateConversation(conv.id, { pinned: !conv.pinned })
              },
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
                onClick: () => void deleteChat()
              }
            ])
          }
        >
          <MoreHorizontal size={17} />
        </button>
        {menu}
      </div>
      <PlanLine conv={conv} />
      <Transcript conversation={conv} header={conv.handoff && <Handoff conv={conv} parent={parent} />} />
      <PermissionPrompts conversationId={conv.id} />
      <Composer conversation={conv} autoFocus />
    </div>
  )
}

/**
 * A sub-conversation's opening, as in Claude: who started it and from which
 * chat, then the task it was handed (folded open), with the context behind it.
 */
function Handoff({ conv, parent }: { conv: Conversation; parent?: Conversation }) {
  const navigate = useApp((s) => s.navigate)
  const [open, setOpen] = useState(true)
  const [ctxOpen, setCtxOpen] = useState(false)
  const h = conv.handoff!
  return (
    <div className="handoff">
      <div className="handoff-from">
        {parent ? (
          <>
            {t('由 {0} 启动，来自', h.by)}{' '}
            <button className="link" onClick={() => navigate({ view: 'chat', conversationId: parent.id })}>
              {parent.title}
            </button>
          </>
        ) : (
          t('由 {0} 从另一个对话启动', h.by)
        )}
      </div>
      <div className="handoff-card">
        <button className="handoff-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('任务')}
          <ChevronDown size={14} className={open ? '' : 'rot'} />
        </button>
        {open && <div className="handoff-task">{h.task}</div>}
        {h.context && (
          <>
            <button className="handoff-ctx" aria-expanded={ctxOpen} onClick={() => setCtxOpen(!ctxOpen)}>
              {t('上下文')}
              <ChevronRight size={14} className={ctxOpen ? 'rot90' : ''} />
            </button>
            {ctxOpen && <div className="handoff-task ctx">{h.context}</div>}
          </>
        )}
      </div>
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
      data-tip={t('点击重命名')}
      onClick={() => {
        setValue(conv.title)
        setEditing(true)
      }}
    >
      {conv.title}
    </button>
  )
}
