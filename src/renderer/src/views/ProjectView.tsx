import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteProject } from '../actions'
import { StatusChip } from '../components/StatusChip'
import { ResizeHandle, paneStyle, usePaneWidth, usePanelSqueezed } from '../components/ResizeHandle'
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  Clock,
  ListTree,
  Maximize2,
  MessagesSquare,
  Minimize2,
  MoreHorizontal,
  NotebookText,
  Search,
  FolderKanban,
  Settings,
  Trash2,
  X,
  ChevronDown,
  Archive,
  ArchiveRestore,
  Milestone,
  CircleDot
} from 'lucide-react'
import type { Conversation, Project } from '@shared/model'
import { Composer } from '../components/Composer'
import { useMenu } from '../components/Menu'
import { PermissionPrompts } from '../components/Permission'
import { Transcript } from '../components/Transcript'
import { planHeadline } from '../components/PlanLine'
import { api, useApp, toastError } from '../store'
import { duration, imeComposing, relTime, threadState } from '../util'
import { EditableTitle } from './ChatView'
import { RenameInput, useRenaming } from '../components/InlineRename'
import { t } from '../i18n'
import { tk } from '@shared/i18n'
import { FilesPane, flushFileEdits } from '../components/FilesPane'
import { ProjectSchedules } from '../components/projects/ProjectSchedules'
import { MemoryPanel } from '../components/projects/ProjectMemory'
import { ProjectEmpty } from '../components/projects/ProjectSection'
import { confirmDialog } from '../components/Modal'
import { BrowserButton } from '../components/BrowserPanel'
import { boardCount, nextMilestone, ProgressPanel } from '../components/ProgressPanel'
import { ThreadReview } from '../components/reviews/ThreadReview'
import { reviewQueueStatus } from '../components/reviews/reviewState'
import { PanelState } from '../components/PanelState'
import { usePanePresence } from '../components/usePanePresence'
import { usePaneViewport } from '../components/usePaneViewport'
import { panelTabKeys } from '../components/OverflowTabs'
import { useFileExpansionActive } from '../components/files/FileExpansion'

export function ProjectView({ projectId, threadId }: { projectId: string; threadId?: string; overview?: boolean }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const conv = useApp((s) => s.conversations.find((c) => c.id === project?.conversationId))
  const set = useApp((s) => s.set)
  const navigate = useApp((s) => s.navigate)
  const anotherPanel = useApp((s) => !!(s.fileView || s.page || s.browserView))
  const navigationVersion = useApp((s) => s.navigationVersion)
  const [panelOpen, setPanelOpen] = useState(true)
  const [wide, setWide] = useState(false)
  const fileExpanded = useFileExpansionActive()
  const [panelTab, setPanelTab] = useState<PanelTab>('threads')
  const panelWidth = usePaneWidth('panel')
  // In a narrow window the panel opens over the conversation, only when asked for.
  const squeezed = usePanelSqueezed()
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    if (threadId) { setPanelOpen(true); setOverlay(squeezed) }
  }, [threadId, navigationVersion])
  // Back beside the conversation, the floating state is over: narrowing again doesn't bring it back by itself.
  useEffect(() => {
    if (!squeezed) setOverlay(false)
    else if (wide || fileExpanded) setOverlay(true)
  }, [squeezed, wide, fileExpanded])
  const showPanel = !anotherPanel && panelOpen && (fileExpanded || wide || !squeezed || overlay)
  const floating = squeezed && showPanel && !wide
  // File inspection temporarily hides the project surface; it must retain its tab and drafts.
  const panelPresence = usePanePresence(panelOpen && (fileExpanded || anotherPanel || wide || !squeezed || overlay))
  const panelRef = useRef<HTMLElement>(null)
  usePaneViewport(panelRef, panelPresence.present)
  // The floating panel closes like a popover: Esc, or a click on the conversation behind it.
  // Esc leaves full screen (a menu or dialog open on top keeps it).
  useEffect(() => {
    if (!wide) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !imeComposing(e) && !document.querySelector('.menu, .overlay')) setWide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide])
  useEffect(() => {
    if (!floating) return
    const busy = () => !!document.querySelector('.menu, .overlay')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !imeComposing(e) && !busy()) setOverlay(false)
    }
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null
      if (!el || busy() || panelRef.current?.contains(el) || el.closest('.menu, .overlay, .tooltip, [data-panel-toggle]')) return
      setOverlay(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [floating])
  const [menu, openMenu] = useMenu({ align: 'right' })
  const rn = useRenaming()
  if (!project || !conv) return <div className="empty">{t('项目不存在或已被删除')}</div>

  const go = (patch: { threadId?: string; overview?: boolean }) => {
    set({ fileView: null, page: null, browserView: null })
    if (threadId && !patch.threadId) setPanelTab('threads')
    setPanelOpen(true)
    setOverlay(squeezed)
    navigate({ view: 'project', projectId, ...patch })
  }
  const openMain = () => {
    set({ fileView: null, page: null, browserView: null })
    setWide(false)
    setOverlay(false)
    setPanelOpen(!squeezed)
    navigate({ view: 'project', projectId })
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.workspace > .center .composer textarea')?.focus({ preventScroll: true }))
  }

  return (
    <div className="workspace">
      <div className="center" inert={wide && showPanel} aria-hidden={wide && showPanel || undefined}>
        <div className="chat-header">
          <span className="proj-icon">
            <FolderKanban size={15} />
          </span>
          {rn.editing ? (
            <RenameInput
                    value={project.name}
              onDone={(name) => {
                rn.stop()
                if (name) void api().updateProject(project.id, { name }).catch(toastError)
              }}
            />
          ) : (
            <span className="chat-title" data-tip={t('双击重命名')} {...rn.onTitle(project.id)}>
              {project.name}
            </span>
          )}
          <span className="spacer" />
          <BrowserButton conversationId={conv.id} />
          <button className={'icon-btn' + (panelOpen && !threadId ? ' on' : '')} data-tip={!showPanel && threadId ? t('打开讨论串') : t('概览')} aria-label={!showPanel && threadId ? t('打开讨论串') : t('概览')} data-panel-toggle onClick={() => void flushFileEdits().then(ok => {
            if (!ok) return
            if (!showPanel && threadId) { set({fileView:null,page:null,browserView:null}); setPanelOpen(true); setOverlay(squeezed) }
            else go({})
          })}><ListTree size={17} /></button>
          <button className="icon-btn" data-tip={t('项目设置')} onClick={() => set({ settingsOpen: `project:${project.id}` })}>
            <Settings size={16} />
          </button>
          <button
            className="icon-btn"
            data-tip={t('更多')}
            onClick={(e) =>
              openMenu(e.currentTarget, [
                {
                  icon: <Download size={15} />,
                  label: t('导出项目对话为 Markdown'),
                  onClick: () => void api().exportConversation(project.conversationId).catch(toastError)
                },
                project.archived
                  ? { icon: <ArchiveRestore size={15} />, label: t('恢复项目'), onClick: () => void api().updateProject(project.id, { archived: false }) }
                  : {
                      icon: <Archive size={15} />,
                      label: t('归档项目'),
                      onClick: () => void api().updateProject(project.id, { archived: true, pinned: false })
                    },
                { separator: true },
                {
                  icon: <Trash2 size={15} />,
                  label: t('删除项目'),
                  danger: true,
                  onClick: () => void deleteProject(project)
                }
              ])
            }
          >
            <MoreHorizontal size={16} />
          </button>
          {menu}
        </div>
        {project.archived && (
          <div className="archived-banner">
            <Archive size={15} />
            <span className="grow">{t('此项目已归档，不再显示在侧栏里。')}</span>
            <button className="btn" onClick={() => void api().updateProject(project.id, { archived: false })}>
              <ArchiveRestore size={14} />
              {t('恢复')}
            </button>
          </div>
        )}
        <ProjectIntro project={project} conv={conv} />
        <PermissionPrompts conversationId={conv.id} />
        <Composer conversation={conv} placeholder={t('提问或开始一项任务…')} autoFocus={!threadId} />
      </div>

      {panelPresence.present && (
        <aside ref={panelRef} hidden={anotherPanel} inert={anotherPanel || panelPresence.exiting} aria-hidden={panelPresence.exiting || undefined} data-exiting={panelPresence.exiting || undefined} className={'panel' + (wide ? ' maximized' : '') + (panelWidth && !wide ? ' sized' : '') + (floating ? ' floating' : '')} style={{ ...(wide ? undefined : paneStyle('panel', panelWidth)), ...(anotherPanel ? { display: 'none' } : {}) }}>
          <ResizeHandle pane="panel" edge="left" onResize={() => setWide(false)} />
          <div className="pane-viewport">
          {threadId ? (
            <ThreadView key={threadId} threadId={threadId} onBack={() => go({})} onClose={() => { setWide(false); setPanelOpen(false); setOverlay(false); requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.workspace > .center .composer textarea')?.focus({ preventScroll: true })) }} onOpenMain={openMain} onOpenThread={(id) => go({ threadId: id })} wide={wide} setWide={setWide} />
          ) : (
            <ThreadList
              project={project}
              onStart={openMain}
              onOpen={(id) => go({ threadId: id })}
              onClose={() => (setWide(false), setPanelOpen(false), setOverlay(false))}
              wide={wide}
              setWide={setWide}
              tab={panelTab}
              setTab={setPanelTab}
            />
          )}</div>
        </aside>
      )}

    </div>
  )
}

function ProjectIntro({ project, conv }: { project: Project; conv: Conversation }) {
  const messages = useApp((s) => s.messages[conv.id])
  if (!messages || messages.filter((m) => !m.hidden).length === 0) {
    return (
      <div className="scroll">
        <div className="transcript project-intro-brief">
          <div className="md">
            <p>{t('欢迎来到')}{' '}<strong>{project.name}</strong>{t('。')}</p>
            <p>
              {t('这里是项目的主对话。您可以直接提问，我会就地回答；需要专门处理的工作，我会为它开一个')}<strong>{t('讨论串')}</strong>{t('，在右侧面板里独立推进，并在完成或需要您时回到这里告诉您。')}</p>
            {project.description && <p className="muted">{project.description}</p>}
          </div>
        </div>
        <TranscriptLoader conv={conv} />
      </div>
    )
  }
  return <Transcript conversation={conv} />
}

/** Makes sure messages are loaded so the intro can decide whether to show. */
function TranscriptLoader({ conv }: { conv: Conversation }) {
  const load = useApp((s) => s.loadMessages)
  useEffect(() => void load(conv.id), [conv.id, load])
  return null
}

function useThreads(projectId: string) {
  const conversations = useApp((s) => s.conversations)
  return useMemo(
    () =>
      conversations
        .filter((c) => c.projectId === projectId && c.kind === 'thread')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, projectId]
  )
}

function ThreadList({ project, onStart, onOpen, onClose, wide, setWide, tab, setTab }: {
  project: Project
  onStart: () => void
  onOpen: (id: string) => void
  onClose: () => void
  wide: boolean
  setWide: (w: boolean) => void
  tab: PanelTab
  setTab: (tab: PanelTab) => void
}) {
  const threads = useThreads(project.id)
  const userName = useApp(s => s.settings.userName)
  const [moreMenu, openMore] = useMenu({ align: 'left', compact: true })
  const extra = MORE.find(item => item.id === tab)
  const chooseTab = (next: PanelTab) => void flushFileEdits().then(ok => ok && setTab(next))
  const [q, setQ] = useState<string | null>(null)
  const shown = threads.filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()))
  // The welcome line speaks for all threads, whatever the search shows.
  const waiting = threads.filter((x) => !x.resolved && ['waiting', 'error'].includes(threadState(x)))
  const working = threads.filter((x) => !x.resolved && threadState(x) === 'working')
  const done = shown.filter((x) => x.resolved || threadState(x) === 'done')
  const board = boardCount(project.progress)
  const next = nextMilestone(project.progress)
  const suggestions = (project.progress ?? []).filter((m) => m.suggested).length

  return (
    <>
      <div className="panel-head">
        <div className="tabs" role="tablist" aria-label={t('项目导航')} onKeyDown={panelTabKeys}>
          <button role="tab" data-tab="threads" aria-selected={tab === 'threads'} className={'tab' + (tab === 'threads' ? ' active' : '')} onClick={() => chooseTab('threads')}>{t('讨论串')}</button>
          <button role="tab" data-tab="library" aria-selected={tab === 'library'} className={'tab' + (tab === 'library' ? ' active' : '')} onClick={() => chooseTab('library')}>{t('库')}</button>
          {extra && <button role="tab" data-tab={tab} aria-selected className="tab active">{t(extra.label)}</button>}
          <button className="icon-btn" data-more data-tip={t('更多')} aria-label={t('更多')} onClick={event => openMore(event.currentTarget, MORE.filter(item => item.id !== 'progress' || !!project.progress?.length).map(item => ({icon:item.icon,label:t(item.label),checked:tab === item.id,onClick:() => chooseTab(item.id)})))}><MoreHorizontal size={16}/></button>
          {moreMenu}
        </div>
        <span className="spacer"/>
        {tab === 'threads' &&
          (q != null ? (
            <input className="input panel-search" autoFocus placeholder={t('搜索讨论串')} value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setQ(null)} />
          ) : (
            <button className="icon-btn" data-tip={t('搜索讨论串')} aria-label={t('搜索讨论串')} onClick={() => setQ('')}>
              <Search size={15} />
            </button>
          ))}
        <button className="icon-btn" data-tip={wide ? t('退出全屏') : t('全屏')} aria-label={wide ? t('退出全屏') : t('全屏')} onClick={() => setWide(!wide)}>
          {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button className="icon-btn" data-tip={t('关闭')} aria-label={t('关闭')} onClick={() => void flushFileEdits().then(ok => ok && onClose())}>
          <X size={16} />
        </button>
      </div>
      <div className="panel-body">
        {tab === 'threads' && (
          <>
            <div className="panel-welcome">
              <h2>{userName ? t('欢迎回来，{0}。', userName) : t('欢迎回来。')}</h2>
              <div className="muted small">{working.length ? t('正在处理中！我会通知您。') : waiting.length ? t('有 {0} 个讨论串在等您处理。', waiting.length) : threads.length ? t('{0} 个讨论串都已解决。', threads.length) : t('讨论串开始后，会在这里跟踪进展：哪些正在进行、哪些在等待您处理、哪些已完成。')}</div>
            </div>
            {(board.total > 0 || suggestions > 0) && <div className="project-overview-meta">
              {board.total > 0 && (
                <button className="progress-summary" onClick={() => setTab('progress')}>
                  <Milestone size={14} />
                  <span className="grow">{next ? t('下一个里程碑：{0}', next.title) : t('所有里程碑都已完成')}</span>
                  <span className="muted">{board.done}/{board.total}</span>
                </button>
              )}
              {suggestions > 0 && (
                <button className="progress-summary" onClick={() => setTab('progress')}>
                  <Milestone size={14} />
                  <span className="grow">{t('有 {0} 条进度建议待确认', suggestions)}</span>
                </button>
              )}
            </div>}
            <div className="thread-list">
              {!threads.length && <ProjectEmpty icon={<MessagesSquare size={26} />} title={t('从主对话开始')}
                description={t('描述要做的事。独立任务会在讨论串中推进，完成后交回主对话审核。')}
                action={<button className="btn primary" onClick={onStart}>{t('描述任务')}</button>} />}
              <ThreadGroup title={t('等待您处理')} items={waiting.filter((x) => shown.includes(x))} onOpen={onOpen} />
              <ThreadGroup title={t('进行中')} items={working.filter((x) => shown.includes(x))} onOpen={onOpen} />
              <ThreadGroup title={t('已解决')} items={done} onOpen={onOpen} collapsed={done.length > 8} />
              {!!q && !shown.length && <PanelState title={t('没有匹配的讨论串')} />}
            </div>
          </>
        )}
        {tab === 'progress' && <ProgressPanel project={project} />}
        {tab === 'library' && <FilesPane id={project.id} />}
        {tab === 'memory' && <MemoryPanel projectId={project.id} />}
        {tab === 'routines' && <ProjectSchedules projectId={project.id} />}
      </div>
    </>
  )
}

type PanelTab = 'threads' | 'library' | 'progress' | 'memory' | 'routines'

/** Navigation order is stable; only destinations that do not fit move into overflow. */
const MORE: { id: PanelTab; label: string; icon: React.ReactNode }[] = [
  { id: 'memory', label: tk('项目记忆'), icon: <NotebookText size={15} /> },
  { id: 'routines', label: tk('定时任务'), icon: <Clock size={15} /> },
  { id: 'progress', label: tk('里程碑'), icon: <Milestone size={15} /> }
]


function ThreadView({ threadId, onBack, onClose, onOpenMain, onOpenThread, wide, setWide }: { threadId: string; onBack: () => void; onClose: () => void; onOpenMain: () => void; onOpenThread: (id: string) => void; wide: boolean; setWide: (w: boolean) => void }) {
  const th = useApp((s) => s.conversations.find((c) => c.id === threadId))
  const [menu, openMenu] = useMenu({ align: 'right' })
  if (!th) return <PanelState title={t('讨论串已删除')} />
  return (
    <div className="thread-view">
      <div className="panel-head">
        <button className="icon-btn" onClick={onBack} data-tip={t('返回讨论串列表')}>
          <ArrowLeft size={16} />
        </button>
        <EditableTitle conv={th} />
        <StatusChip conv={th} />
        <span className="spacer" />
        <BrowserButton conversationId={th.id} />
        {wide && !th.isolateWorkspace && (
          <button className="icon-btn" data-tip={th.resolved ? t('重新打开') : t('标记为已解决')} onClick={() => void api().updateConversation(th.id, { resolved: !th.resolved })}>
            <CheckCircle2 size={15} />
          </button>
        )}
        <button className="icon-btn" data-tip={wide ? t('退出全屏') : t('全屏')} onClick={() => setWide(!wide)}>
          {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          className="icon-btn"
          data-tip={t('更多')}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              {
                icon: <CheckCircle2 size={15} />,
                label: th.isolateWorkspace && !th.resolved ? t('主对话建议') : th.resolved ? t('重新打开') : t('标记为已解决'),
                disabled: th.isolateWorkspace && !th.resolved && !th.review,
                onClick: () => th.isolateWorkspace && !th.resolved ? document.querySelector('.thread-review')?.scrollIntoView({ block: 'start' }) : void api().updateConversation(th.id, { resolved: !th.resolved }).catch(toastError)
              },
              {
                icon: <Download size={15} />,
                label: t('导出为 Markdown'),
                onClick: () => void api().exportConversation(th.id).catch(toastError)
              },
              {
                icon: <Trash2 size={15} />,
                label: t('删除讨论串'),
                danger: true,
                onClick: async () => {
                  if (!(await confirmDialog(t('删除讨论串「{0}」？', th.title)))) return
                  void api().deleteConversation(th.id)
                  onBack()
                }
              }
            ])
          }
        >
          <MoreHorizontal size={16} />
        </button>
          <button className="icon-btn" data-tip={t('关闭讨论串')} aria-label={t('关闭讨论串')} onClick={onClose}>
            <X size={16} />
          </button>
        {menu}
      </div>
      <div className="thread-reading-area"><Transcript conversation={th} compact header={<><ThreadRoot thread={th} /><ThreadEmpty thread={th} /></>} /></div>
      {th.review && <div className="thread-review-dock"><ThreadReview key={th.review.id} thread={th} wide={wide} onOpenThread={onOpenThread} onOpenMain={onOpenMain} /></div>}
      <PermissionPrompts conversationId={th.id} />
      <Composer conversation={th} placeholder={t('在讨论串中回复…')} />
    </div>
  )
}

function ThreadEmpty({ thread }: { thread: Conversation }) {
  const messages = useApp((s) => s.messages[thread.id])
  if (thread.review || !messages || messages.some((m) => !m.hidden && m.role !== 'system')) return null
  return <div className="thread-empty-content">
    <PanelState title={t('讨论串已创建')}>{t('任务结果和后续讨论会显示在这里。')}</PanelState>
  </div>
}

/** The request in the project chat that this thread grew out of, shown at its top like Claude's thread root. */
function ThreadRoot({ thread }: { thread: Conversation }) {
  const root = useApp((s) => {
    const p = s.projects.find((x) => x.id === thread.projectId)
    const list = (p && s.messages[p.conversationId]) || []
    const i = list.findIndex((m) => m.id === thread.anchorMessageId)
    for (let j = i; j >= 0; j--) if (list[j].role === 'user' && !list[j].hidden) return list[j]
    return undefined
  })
  const text = root?.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
  if (!root || !text) return null
  return (
    <div className="thread-root">
      <div className="small muted">{t('来自项目对话 ·')}{' '}{relTime(root.createdAt)}</div>
      <div className="thread-root-text">{text}</div>
    </div>
  )
}

/** Progress of a thread's checklist: steps done and in total. */
function progressOf(checklist?: string): { done: number; total: number } | undefined {
  const steps = (checklist ?? '').split('\n').map((l) => l.replace(/\*\*/g, '').trim()).filter((l) => /^[✓✱○]/.test(l))
  return steps.length ? { done: steps.filter((l) => l.startsWith('✓')).length, total: steps.length } : undefined
}

function ThreadGroup({
  title,
  items,
  onOpen,
  collapsed,
  children
}: {
  title: string
  items: Conversation[]
  onOpen: (id: string) => void
  collapsed?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(!collapsed)
  const count = children ? undefined : items.length
  if (!items.length && !children) return null
  return (
    <div className="thread-group">
      <button className="thread-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={14} className={'chev' + (open ? '' : ' closed')} />
        <span>{title}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </button>
      {open && (
        <div className="thread-group-body">
          {children ?? items.map((th) => <ThreadRow key={th.id} th={th} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  )
}

function ThreadRow({ th, onOpen }: { th: Conversation; onOpen: (id: string) => void }) {
  const st = threadState(th)
  const step = planHeadline(th)
  const progress = th.resolved ? undefined : progressOf(th.checklist)
  // A message from another thread waiting to be handed over says so on the board.
  const waiting = useApp((s) => s.peerMessages.find((m) => m.toId === th.id && m.state === 'pending'))
  const from = useApp((s) => (waiting ? s.conversations.find((c) => c.id === waiting.fromId)?.title : undefined))
  const rn = useRenaming()
  return (
    // Not a <button>: the rename field goes inside it.
    <div
      className="thread-row"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(th.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        onOpen(th.id)
      }}
    >
      <span className="text">
        <span className="title">
          {th.unread && <span className="dot unread" />}
          {rn.editing ? (
            <RenameInput
              value={th.title}
              onDone={(title) => {
                rn.stop()
                if (title) void api().updateConversation(th.id, { title }).catch(toastError)
              }}
            />
          ) : (
            <span className="title-text" {...rn.onTitle(th.id)}>
              {th.title}
            </span>
          )}
        </span>
        <span className="sub">{th.review?.state === 'pending' ? `${reviewQueueStatus(th)} · ${th.review.recommendation?.summary || th.review.summary}` : st === 'working' && step ? step : st === 'error' ? t('出错') : th.lastPreview ?? ''}</span>
        {waiting && (
          <span className="sub peer-waiting">
            <CircleDot size={11} />
            {waiting.deliver === 'after_current_task' ? t('「{0}」的留言等这里做完再送', from ?? '') : t('「{0}」的留言等这里空闲再送', from ?? '')}
          </span>
        )}
      </span>
      {progress && st === 'working' && (
        <span className="progress" data-tip={t('{0}/{1} 步', progress.done, progress.total)}>
          <Ring value={progress.done / progress.total} />
          {progress.done}/{progress.total}
        </span>
      )}
      <span className="meta">{st === 'working' ? duration(Date.now() - th.createdAt) : relTime(th.updatedAt)}</span>
    </div>
  )
}

function Ring({ value }: { value: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="ring">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--accent)" strokeWidth="2" strokeDasharray={`${c * value} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  )
}
