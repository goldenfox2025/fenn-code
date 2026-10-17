import { useShallow } from 'zustand/react/shallow'
import { GitBranch, Loader2, Square, SquareTerminal, X } from 'lucide-react'
import type { Conversation } from '@shared/model'
import { api, useApp, toastError } from '../store'
import { t } from '../i18n'
import { relTime } from '../util'
import { StatusChip } from './StatusChip'
import { FilesPane } from './FilesPane'
import { paneStyle, ResizeHandle, usePaneWidth } from './ResizeHandle'

/**
 * The pane beside a chat, as in Claude Code: the folder's files, and the work
 * running in the background (sub-conversations, commands the agent runs
 * through the app). It stays open from chat to chat until closed.
 */
export function ChatSidePane({ conversationId }: { conversationId: string }) {
  const tab = useApp((s) => s.sidePane)
  const conv = useApp((s) => s.conversations.find((c) => c.id === conversationId))
  const width = usePaneWidth('panel')
  if (!tab || !conv) return null
  const set = (sidePane: 'files' | 'background' | null) => useApp.getState().set({ sidePane })
  return (
    <aside className={'side-pane' + (width ? ' sized' : '')} style={paneStyle('panel', width)} aria-label={t('文件与后台')}>
      <ResizeHandle pane="panel" edge="left" />
      <div className="panel-head">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'files'} className={'tab' + (tab === 'files' ? ' active' : '')} onClick={() => set('files')}>
            {t('文件')}
          </button>
          <button role="tab" aria-selected={tab === 'background'} className={'tab' + (tab === 'background' ? ' active' : '')} onClick={() => set('background')}>
            {t('后台')}
            <RunningCount conv={conv} />
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" data-tip={t('关闭')} aria-label={t('关闭')} onClick={() => set(null)}>
          <X size={16} />
        </button>
      </div>
      <div className="panel-body">{tab === 'files' ? <FilesPane id={conv.parentId ?? conv.id} /> : <BackgroundList conv={conv} />}</div>
    </aside>
  )
}

/** How many things run in the background of this chat now (none: nothing shown). */
export function useRunning(conv: Conversation): number {
  return useApp(
    (s) =>
      s.conversations.filter((c) => c.parentId === (conv.parentId ?? conv.id) && c.status === 'working').length +
      (conv.background ?? []).filter((b) => !b.endedAt).length
  )
}

function RunningCount({ conv }: { conv: Conversation }) {
  const n = useRunning(conv)
  return n ? <span className="tab-count">{n}</span> : null
}

function BackgroundList({ conv }: { conv: Conversation }) {
  const top = useApp((s) => s.conversations.find((c) => c.id === (conv.parentId ?? conv.id)))
  const children = useApp(useShallow((s) => s.conversations.filter((c) => c.parentId === (conv.parentId ?? conv.id)).sort((a, b) => b.updatedAt - a.updatedAt)))
  const navigate = useApp((s) => s.navigate)
  const commands = [...(top?.background ?? []), ...(conv.parentId ? conv.background ?? [] : [])].sort((a, b) => b.startedAt - a.startedAt)
  if (!children.length && !commands.length)
    return (
      <div className="empty">
        <div>{t('没有后台任务')}</div>
        <div className="small">{t('子对话，以及 agent 通过 Ancora 运行的命令，会显示在这里。输入「/」可以开子对话。')}</div>
      </div>
    )
  const owner = (id: string) => (top?.background?.some((b) => b.id === id) ? top.id : conv.id)
  return (
    <div className="thread-list">
      {children.length > 0 && <div className="thread-group-head">{t('子对话')}</div>}
      {children.map((c) => (
        <button key={c.id} className={'thread-item' + (c.id === conv.id ? ' active' : '')} onClick={() => navigate({ view: 'chat', conversationId: c.id })}>
          <div className="row1">
            <GitBranch size={14} className="muted" />
            <span className="title">{c.title}</span>
            <StatusChip conv={c} />
          </div>
          <div className="preview">{relTime(c.updatedAt)}</div>
        </button>
      ))}
      {commands.length > 0 && <div className="thread-group-head">{t('命令')}</div>}
      {commands.map((b) => (
        <div key={b.id + b.startedAt} className="thread-item bg-command">
          <div className="row1">
            {b.endedAt ? <SquareTerminal size={14} className="muted" /> : <Loader2 size={14} className="spin muted" />}
            <code className="title">{b.command}</code>
            {!b.endedAt ? (
              <button
                className="icon-btn sm"
                data-tip={t('停止')}
                aria-label={t('停止')}
                onClick={() => void api().stopCommand(owner(b.id), b.id).catch(toastError)}
              >
                <Square size={12} />
              </button>
            ) : (
              <span className={'status-chip ' + (b.exitCode === 0 ? 'done' : b.exitCode == null ? '' : 'error')}>
                {b.exitCode === 0 ? t('完成') : b.exitCode == null ? t('已结束') : t('退出码 {0}', b.exitCode)}
              </span>
            )}
          </div>
          <div className="preview">{b.endedAt ? relTime(b.endedAt) : t('{0}开始', relTime(b.startedAt))}</div>
        </div>
      ))}
    </div>
  )
}
