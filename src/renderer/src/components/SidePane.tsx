import { useShallow } from 'zustand/react/shallow'
import { ChevronRight, Eye, GitBranch, Loader2, Square, SquareTerminal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BackgroundCommand, Conversation } from '@shared/model'
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
        <div className="small">{t('子对话，以及 agent 在后台运行的命令，会显示在这里。输入「/」可以开子对话。')}</div>
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
        <CommandEntry key={b.id + b.startedAt} command={b} owner={owner(b.id)} />
      ))}
    </div>
  )
}

/** A background command: click to read its output, followed live while it runs. */
function CommandEntry({ command: b, owner }: { command: BackgroundCommand; owner: string }) {
  const [open, setOpen] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  const running = !b.endedAt
  useEffect(() => {
    if (!open) return
    let gone = false
    const read = () =>
      void api()
        .commandOutput(owner, b.id)
        .then((text) => !gone && setOutput(text))
        .catch(() => !gone && setOutput(''))
    read()
    const timer = running ? setInterval(read, 1000) : undefined
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [open, running, owner, b.id])
  useEffect(() => {
    const el = pre.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])
  return (
    <div className={'thread-item bg-command' + (open ? ' open' : '')}>
      <div className="row1" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(!open))}>
        {running ? <Loader2 size={14} className="spin muted" /> : b.monitor ? <Eye size={14} className="muted" /> : <SquareTerminal size={14} className="muted" />}
        {b.title ? (
          <span className="title" data-tip={b.command}>
            {b.title}
          </span>
        ) : (
          <code className="title">{b.command}</code>
        )}
        {/* The agent's own background tasks are its to stop; Ancora can only stop what runs in its terminal. */}
        {running && b.managed ? (
          <span className="status-chip">{b.monitor ? t('监视中') : t('运行中')}</span>
        ) : running ? (
          <button
            className="icon-btn sm"
            data-tip={t('停止')}
            aria-label={t('停止')}
            onClick={(e) => {
              e.stopPropagation()
              void api().stopCommand(owner, b.id).catch(toastError)
            }}
          >
            <Square size={12} />
          </button>
        ) : (
          <span className={'status-chip ' + (b.exitCode === 0 ? 'done' : b.exitCode == null ? '' : 'error')}>
            {b.exitCode === 0 ? t('完成') : b.exitCode == null ? t('已结束') : t('退出码 {0}', b.exitCode)}
          </span>
        )}
        <ChevronRight size={14} className="muted bg-chevron" />
      </div>
      <div className="preview">{b.endedAt ? relTime(b.endedAt) : Date.now() - b.startedAt < 60_000 ? t('刚刚开始') : t('{0}开始', relTime(b.startedAt))}</div>
      {open && (
        <>
          {b.title && <code className="bg-full-command">{b.command}</code>}
          {output ? (
            <pre ref={pre} className="bg-output">
              {output}
            </pre>
          ) : (
            <div className="preview">{output == null ? <span className="shimmer">{t('正在读取输出…')}</span> : running ? t('还没有输出') : t('没有输出')}</div>
          )}
        </>
      )}
    </div>
  )
}
