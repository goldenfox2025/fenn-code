import { useState } from 'react'
import { deleteChat } from '../actions'
import { ChevronDown, ChevronRight, CornerUpLeft, Download, FolderOpen, MoreHorizontal, Pin, PinOff, Trash2 } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { Composer } from '../components/Composer'
import { useMenu } from '../components/Menu'
import { PermissionPrompts } from '../components/Permission'
import { Transcript } from '../components/Transcript'
import { api, useApp, toastError } from '../store'
import { t } from '../i18n'
import { BrowserButton } from '../components/BrowserPanel'
import { useRunning } from '../components/SidePane'
import { RenameInput, useRenaming } from '../components/InlineRename'

export function ChatView({ conversationId }: { conversationId: string }) {
  const conv = useApp((s) => s.conversations.find((c) => c.id === conversationId))
  const parent = useApp((s) => s.conversations.find((c) => c.id === conv?.parentId))
  const navigate = useApp((s) => s.navigate)
  const [menu, openMenu] = useMenu({ align: 'right' })
  if (!conv) return <div className="empty">{t('对话不存在或已被删除')}</div>

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
        <BrowserButton conversationId={conv.id} />
        <SidePaneButton conv={conv} />
        <button
          className="icon-btn"
          data-tip={t('更多对话操作')}
          aria-label={t('更多对话操作')}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              {
                icon: conv.pinned ? <PinOff size={15} /> : <Pin size={15} />,
                label: conv.pinned ? t('取消置顶') : t('置顶'),
                onClick: () => void api().updateConversation(conv.id, { pinned: !conv.pinned }).catch(toastError)
              },
              { separator: true },
              {
                icon: <Download size={15} />,
                label: t('导出为 Markdown'),
                onClick: () => void api().exportConversation(conv.id).catch(toastError)
              },
              // A project's main conversation goes with its project, never on its own.
              ...(conv.kind === 'project'
                ? []
                : [
                    {
                      icon: <Trash2 size={15} />,
                      label: t('删除对话'),
                      danger: true,
                      onClick: () => void deleteChat(conv)
                    }
                  ])
            ])
          }
        >
          <MoreHorizontal size={17} />
        </button>
        {menu}
      </div>
      <Transcript conversation={conv} header={conv.handoff && <Handoff conv={conv} parent={parent} />} />
      <PermissionPrompts conversationId={conv.id} />
      <Composer conversation={conv} autoFocus />
    </div>
  )
}

/** Opens the files and background pane beside the chat (a dot while something runs in the background). */
function SidePaneButton({ conv }: { conv: Conversation }) {
  // A page or file open beside the chat covers the pane: then the button brings the pane back.
  const open = useApp((s) => (s.page || s.fileView || s.browserView ? null : s.sidePane))
  const running = useRunning(conv)
  return (
    <button
      className={'icon-btn side-pane-toggle' + (open ? ' on' : '')}
      data-tip={running ? t('文件与后台（{0} 个在运行）', running) : t('文件与后台')}
      aria-label={t('文件与后台')}
      aria-pressed={!!open}
      onClick={() => {
        const shown = useApp.getState().sidePane
        useApp.getState().set({ sidePane: open ? null : (shown ?? (running ? 'background' : 'files')), page: null, fileView: null, browserView: null })
      }}
    >
        <FolderOpen size={16} />
      {running > 0 && <span className="run-dot" />}
    </button>
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

/**
 * A conversation's title in its header. A double click renames it in place (Enter
 * from the keyboard too); a single click does nothing else.
 */
export function EditableTitle({ conv }: { conv: Conversation }) {
  const rn = useRenaming()
  if (rn.editing)
    return (
      <RenameInput
        value={conv.title}
        onDone={(title) => {
          rn.stop()
          if (title) void api().updateConversation(conv.id, { title }).catch(toastError)
        }}
      />
    )
  return (
    <button
      className="chat-title"
      data-tip={t('双击重命名')}
      {...rn.onTitle(conv.id)}
      // A click from the keyboard (Enter, Space) has no pointer: it renames.
      onClick={(e) => e.detail === 0 && rn.start(conv.id)}
    >
      {conv.title}
    </button>
  )
}
