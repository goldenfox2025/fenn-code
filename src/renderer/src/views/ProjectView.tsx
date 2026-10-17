import { useEffect, useMemo, useRef, useState } from 'react'
import { deleteProject } from '../actions'
import { StatusChip } from '../components/StatusChip'
import { ResizeHandle, paneStyle, usePaneWidth, usePanelSqueezed } from '../components/ResizeHandle'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  Clock,
  ListChecks,
  Maximize2,
  MessagesSquare,
  Minimize2,
  MoreHorizontal,
  NotebookText,
  Paperclip,
  Plus,
  Search,
  FolderKanban,
  Settings,
  Trash2,
  X,
  ChevronDown,
  Archive,
  ArchiveRestore,
  Milestone,
  Gauge,
  PackageOpen,
  CircleDot
} from 'lucide-react'
import type { Conversation, MemoryEntry, Project } from '@shared/model'
import { Composer } from '../components/Composer'
import { humanSize, OutputsPanel } from '../components/Outputs'
import { Dropdown, useMenu } from '../components/Menu'
import { PermissionPrompts } from '../components/Permission'
import { Transcript } from '../components/Transcript'
import { PlanLine, planHeadline } from '../components/PlanLine'
import { api, useApp, toastError } from '../store'
import { duration, relTime, threadState } from '../util'
import { EditableTitle } from './ChatView'
import { locale, t } from '../i18n'
import { tk } from '@shared/i18n'
import { FilesPane } from '../components/FilesPane'
import { confirmDialog, EscLayer } from '../components/Modal'
import { UsageButton, usageLine } from '../components/Usage'
import { sumTotals } from '@shared/usage'
import { boardCount, nextMilestone, ProgressPanel } from '../components/ProgressPanel'

export function ProjectView({ projectId, threadId }: { projectId: string; threadId?: string; overview?: boolean }) {
  const project = useApp((s) => s.projects.find((p) => p.id === projectId))
  const conv = useApp((s) => s.conversations.find((c) => c.id === project?.conversationId))
  const set = useApp((s) => s.set)
  const navigate = useApp((s) => s.navigate)
  const userName = useApp((s) => s.settings.userName)
  const [panelOpen, setPanelOpen] = useState(true)
  const [wide, setWide] = useState(false)
  const panelWidth = usePaneWidth('panel')
  // In a narrow window the panel opens over the conversation, only when asked for.
  const squeezed = usePanelSqueezed()
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    if (threadId) setOverlay(true)
  }, [threadId])
  // Back beside the conversation, the floating state is over: narrowing again doesn't bring it back by itself.
  useEffect(() => {
    if (!squeezed) setOverlay(false)
  }, [squeezed])
  const showPanel = panelOpen && (!squeezed || overlay)
  const floating = squeezed && showPanel
  const panelRef = useRef<HTMLElement>(null)
  // The floating panel closes like a popover: Esc, or a click on the conversation behind it.
  // Esc leaves full screen (a menu or dialog open on top keeps it).
  useEffect(() => {
    if (!wide) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.menu, .overlay')) setWide(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wide])
  useEffect(() => {
    if (!floating) return
    const busy = () => !!document.querySelector('.menu, .overlay')
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy()) setOverlay(false)
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
  if (!project || !conv) return <div className="empty">{t('项目不存在或已被删除')}</div>

  const go = (patch: { threadId?: string; overview?: boolean }) => {
    setPanelOpen(true)
    navigate({ view: 'project', projectId, ...patch })
  }

  return (
    <div className="workspace">
      <div className="center">
        <div className="chat-header">
          <span className="proj-icon">
            <FolderKanban size={15} />
          </span>
          <span className="chat-title" style={{ cursor: 'default' }}>
            {project.name}
          </span>
          <span className="spacer" />
          <button className={'pill-btn' + (panelOpen && !threadId ? ' active' : '')} onClick={() => go({})}>
            <ListChecks size={15} />
            {t('概览')}</button>
          <button className="icon-btn" data-tip={t('项目设置')} onClick={() => set({ settingsOpen: `project:${project.id}` })}>
            <Settings size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={(e) =>
              openMenu(e.currentTarget, [
                {
                  icon: <Download size={15} />,
                  label: t('导出项目对话为 Markdown'),
                  onClick: () => void api().exportConversation(project.conversationId)
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

      {showPanel && (
        <aside ref={panelRef} className={'panel' + (wide ? ' maximized' : '') + (panelWidth && !wide ? ' sized' : '') + (squeezed ? ' floating' : '')} style={wide ? undefined : paneStyle('panel', panelWidth)}>
          <ResizeHandle pane="panel" edge="left" onResize={() => setWide(false)} />
          {threadId ? (
            <ThreadView threadId={threadId} onBack={() => go({})} wide={wide} setWide={setWide} />
          ) : (
            <ThreadList
              project={project}
              userName={userName}
              onOpen={(id) => go({ threadId: id })}
              onClose={() => (setPanelOpen(false), setOverlay(false))}
              wide={wide}
              setWide={setWide}
            />
          )}
        </aside>
      )}
      {!showPanel && (
        <button className="icon-btn" style={{ position: 'absolute', right: 12, top: 52 }} data-panel-toggle data-tip={t('打开讨论串')} onClick={() => (setPanelOpen(true), setOverlay(true))}>
          <MessagesSquare size={17} />
        </button>
      )}
    </div>
  )
}

function ProjectIntro({ project, conv }: { project: Project; conv: Conversation }) {
  const messages = useApp((s) => s.messages[conv.id])
  if (!messages || messages.filter((m) => !m.hidden).length === 0) {
    return (
      <div className="scroll">
        <div className="transcript" style={{ paddingTop: 40 }}>
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

function ThreadList({ project, userName, onOpen, onClose, wide, setWide }: {
  project: Project
  userName: string
  onOpen: (id: string) => void
  onClose: () => void
  wide: boolean
  setWide: (w: boolean) => void
}) {
  const threads = useThreads(project.id)
  const routines = useApp(useShallow((s) => s.routines.filter((r) => r.target.projectId === project.id)))
  const [tab, setTab] = useState<PanelTab>('threads')
  const [moreMenu, openMore] = useMenu({ align: 'left', compact: true })
  const extra = MORE.find((m) => m.id === tab)
  const [q, setQ] = useState<string | null>(null)
  const shown = threads.filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()))
  const waiting = shown.filter((x) => !x.resolved && ['waiting', 'error'].includes(threadState(x)))
  const working = shown.filter((x) => !x.resolved && threadState(x) === 'working')
  const done = shown.filter((x) => x.resolved || threadState(x) === 'done')
  const board = boardCount(project.progress)
  const next = nextMilestone(project.progress)
  const suggestions = (project.progress ?? []).filter((m) => m.suggested).length
  const usage = useApp(useShallow((s) => s.conversations.filter((c) => c.projectId === project.id && !s.backends.find((b) => b.id === c.backendId)?.credits).map((c) => c.usage)))
  const totals = sumTotals(usage)

  return (
    <>
      <div className="panel-head">
        <div className="tabs" role="tablist">
          <button role="tab" data-tab="threads" aria-selected={tab === 'threads'} className={'tab' + (tab === 'threads' ? ' active' : '')} onClick={() => setTab('threads')}>
            {t('讨论串')}
          </button>
          <button role="tab" data-tab="library" aria-selected={tab === 'library'} className={'tab' + (tab === 'library' ? ' active' : '')} onClick={() => setTab('library')}>
            {t('库')}
          </button>
          {extra && (
            <button role="tab" data-tab={tab} aria-selected className="tab active">
              {t(extra.label)}
            </button>
          )}
          <button
            className="icon-btn"
            data-more
            data-tip={t('更多')}
            aria-label={t('更多')}
            onClick={(e) => openMore(e.currentTarget, MORE.filter((m) => m.id !== 'progress' || !!project.progress?.length).map((m) => ({ icon: m.icon, label: t(m.label), checked: tab === m.id, onClick: () => setTab(m.id) })))}
          >
            <MoreHorizontal size={16} />
          </button>
          {moreMenu}
        </div>
        <span className="spacer" />
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
        <button className="icon-btn" data-tip={t('关闭')} aria-label={t('关闭')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="panel-body">
        {tab === 'threads' && (
          <>
            <div className="panel-welcome">
              <h2>{userName ? t('欢迎回来，{0}。', userName) : t('欢迎回来。')}</h2>
              <div className="muted small">
                {working.length
                  ? t('正在处理中！我会通知您。')
                  : waiting.length
                    ? t('有 {0} 个讨论串在等您处理。', waiting.length)
                    : threads.length
                      ? t('{0} 个讨论串都已解决。', threads.length)
                      : t('讨论串开始后，会在这里跟踪进展：哪些正在进行、哪些在等待您处理、哪些已完成。')}
              </div>
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
              {totals.turns + totals.unreported > 0 && (
                <UsageButton usage={totals} scope={t('项目用量（所有对话和讨论串）')} className="progress-summary usage-summary" align="left">
                  <Gauge size={14} />
                  <span className="grow">{t('项目用量')}</span>
                  <span className="muted">{totals.turns ? usageLine({ total: totals.total || !totals.cost ? totals.total : undefined, cost: totals.cost }) : t('用量')}</span>
                </UsageButton>
              )}
            </div>
            <div className="thread-list">
              <ThreadGroup title={t('等待您处理')} empty={t('决策、审阅和权限请求。')} items={waiting} onOpen={onOpen} />
              <ThreadGroup title={t('进行中')} empty={t('正在推进的讨论串。')} items={working} onOpen={onOpen} />
              <ThreadGroup title={t('已解决')} empty={t('已完成的讨论串。')} items={done} onOpen={onOpen} collapsed={done.length > 8} />
            </div>
          </>
        )}
        {tab === 'progress' && <ProgressPanel project={project} />}
        {tab === 'library' && <FilesPane id={project.id} />}
        {tab === 'outputs' && <OutputsPanel project={project} />}
        {tab === 'memory' && <MemoryPanel projectId={project.id} />}
        {tab === 'files' && <FilesPanel projectId={project.id} />}
        {tab === 'routines' && (
          <div className="thread-list">
            <div className="list-head">
              <span className="muted small">{t('按时间自动在这个项目里运行的任务。')}</span>
              <span className="spacer" />
              <button className="btn sm" onClick={() => useApp.getState().set({ settingsOpen: `routine:new:${project.id}` })}>
                <Plus size={14} />
                {t('新建定时任务')}
              </button>
            </div>
            {routines.length === 0 && <div className="empty">{t('此项目还没有定时任务。')}</div>}
            {routines.map((r) => (
              <div key={r.id} className="thread-item">
                <div className="row1">
                  <Clock size={14} />
                  <span className="title">{r.name}</span>
                  <span className={'status-chip ' + (r.enabled ? 'done' : '')}>{r.enabled ? t('启用') : r.pausedByArchive ? t('随项目暂停') : t('暂停')}</span>
                </div>
                {r.nextRunAt && <div className="preview">{t('下次运行：')}{new Date(r.nextRunAt).toLocaleString(locale)}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

type PanelTab = 'threads' | 'library' | 'progress' | 'outputs' | 'memory' | 'files' | 'routines'

/** The project panel's other views, under 更多: the two tabs are 讨论串 and 库, as in Claude. */
const MORE: { id: PanelTab; label: string; icon: React.ReactNode }[] = [
  { id: 'outputs', label: tk('成果'), icon: <PackageOpen size={15} /> },
  { id: 'files', label: tk('项目资料'), icon: <Paperclip size={15} /> },
  { id: 'memory', label: tk('项目记忆'), icon: <NotebookText size={15} /> },
  { id: 'routines', label: tk('定时任务'), icon: <Clock size={15} /> },
  { id: 'progress', label: tk('里程碑'), icon: <Milestone size={15} /> }
]

function FilesPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<{ name: string; size: number; updatedAt: number }[] | null>(null)
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const reload = () => api().listProjectFiles(projectId).then(setItems)
  useEffect(() => {
    void reload()
  }, [projectId])
  const add = async (list: FileList) => {
    try {
      const files = await Promise.all(
        Array.from(list).map(async (f) => {
          const buf = new Uint8Array(await f.arrayBuffer())
          let bin = ''
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
          return { name: f.name, data: btoa(bin) }
        })
      )
      await api().addProjectFiles(projectId, files)
    } catch (e) {
      toastError(e)
    }
    void reload()
  }
  return (
    <div
      className={'thread-list' + (dragging ? ' dropping' : '')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void add(e.dataTransfer.files)
      }}
    >
      <div className="panel-welcome" style={{ padding: '12px 8px 4px' }}>
        <div className="muted small">{t('放进项目的资料，项目里的每个 agent 都能读到。可以把文件拖到这里。')}</div>
      </div>
      {items?.length === 0 && <div className="empty">{t('还没有文件。')}</div>}
      {items?.map((f) => (
        <div key={f.name} className="thread-item file-item">
          <div className="row1">
            <FileText size={15} className="muted" />
            <span className="title">{f.name}</span>
            <span className="small muted">{humanSize(f.size)}</span>
            <button
              className="icon-btn sm"
              data-tip={t('移除')}
              onClick={async () => {
                if (!(await confirmDialog(t('从项目中移除「{0}」？', f.name), { ok: t('移除') }))) return
                await api().deleteProjectFile(projectId, f.name)
                void reload()
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
      <div style={{ padding: 8 }}>
        <button className="btn" onClick={() => picker.current?.click()}>
          <Plus size={14} />
          {t('添加文件')}</button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void add(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}


function MemoryPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<MemoryEntry[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<Partial<MemoryEntry> | null>(null)
  const reload = () => api().listMemory(projectId).then(setItems)
  // Reloads when an agent or the user changes the memory, instead of polling.
  const version = useApp((s) => s.memoryVersion[projectId] ?? 0)
  useEffect(() => {
    void reload()
  }, [projectId, version])
  if (editing)
    return (
      <div style={{ padding: 16 }}>
        <EscLayer onClose={() => setEditing(null)} />
        <div className="field">
          <label>{t('名称')}</label>
          <input className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="release-date" />
        </div>
        <div className="field">
          <label>{t('一句话描述')}</label>
          <input className="input" value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('类型')}</label>
          <Dropdown
            value={editing.type ?? 'project'}
            onChange={(v) => setEditing({ ...editing, type: v })}
            options={[
              { value: 'user', label: t('关于用户') },
              { value: 'feedback', label: t('工作方式要求') },
              { value: 'project', label: t('项目事实与决定') },
              { value: 'reference', label: t('外部资源') }
            ]}
          />
        </div>
        <div className="field">
          <label>{t('内容')}</label>
          <textarea className="textarea" style={{ minHeight: 160 }} value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => setEditing(null)}>
            {t('取消')}</button>
          <button
            className="btn primary"
            disabled={!editing.name?.trim() || !editing.body?.trim()}
            onClick={async () => {
              await api().saveMemory(projectId, {
                name: editing.name!,
                description: editing.description || editing.name!,
                type: editing.type,
                body: editing.body!
              })
              setEditing(null)
              void reload()
            }}
          >
            {t('保存')}</button>
        </div>
      </div>
    )
  return (
    <div className="thread-list">
      <div className="panel-welcome" style={{ padding: '12px 8px 4px' }}>
        <div className="muted small">{t('项目里的每个 agent 都能读写这些记忆，它们跨会话、跨重启保留。您也可以直接修改。')}</div>
      </div>
      {items?.length === 0 && <div className="empty">{t('还没有记忆。agent 会在工作中记下您的偏好、决定和项目事实。')}</div>}
      {items?.map((m) => (
        <div key={m.name} className="thread-item" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === m.name ? null : m.name)}>
          <div className="row1">
            <span className="title">{m.name}</span>
            <span className="status-chip">{{ user: t('用户'), feedback: t('要求'), project: t('项目'), reference: t('资源') }[m.type] ?? m.type}</span>
          </div>
          <div className="preview">{m.description}</div>
          {open === m.name && (
            <>
              <div className="tool-detail" style={{ marginLeft: 0, fontFamily: 'var(--font)', fontSize: 13 }}>{m.body}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn" onClick={(e) => (e.stopPropagation(), setEditing(m))}>
                  {t('编辑')}</button>
                <button
                  className="btn danger"
                  onClick={async (e) => {
                    e.stopPropagation()
                    if (!(await confirmDialog(t('删除记忆「{0}」？', m.name)))) return
                    await api().deleteMemory(projectId, m.name)
                    void reload()
                  }}
                >
                  {t('删除')}</button>
              </div>
            </>
          )}
        </div>
      ))}
      <div style={{ padding: 8 }}>
        <button className="btn" onClick={() => setEditing({ type: 'project' })}>
          <Plus size={14} />
          {t('添加记忆')}</button>
      </div>
    </div>
  )
}

function ThreadView({ threadId, onBack, wide, setWide }: { threadId: string; onBack: () => void; wide: boolean; setWide: (w: boolean) => void }) {
  const th = useApp((s) => s.conversations.find((c) => c.id === threadId))
  const [menu, openMenu] = useMenu({ align: 'right' })
  if (!th) return <div className="empty">{t('讨论串已删除')}</div>
  const st = threadState(th)
  return (
    <div className="thread-view" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-head">
        <button className="icon-btn" onClick={onBack} data-tip={t('返回讨论串列表')}>
          <ArrowLeft size={16} />
        </button>
        <EditableTitle conv={th} />
        <StatusChip conv={th} />
        <span className="spacer" />
        <UsageButton usage={th.usage} timing={th.timing} backendId={th.backendId} scope={t('本讨论串用量')} creditsOnly />
        {wide && (
          <button className="icon-btn" data-tip={th.resolved ? t('重新打开') : t('标记为已解决')} onClick={() => void api().updateConversation(th.id, { resolved: !th.resolved })}>
            <CheckCircle2 size={15} />
          </button>
        )}
        <button className="icon-btn" data-tip={wide ? t('退出全屏') : t('全屏')} onClick={() => setWide(!wide)}>
          {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button
          className="icon-btn"
          onClick={(e) =>
            openMenu(e.currentTarget, [
              {
                icon: <CheckCircle2 size={15} />,
                label: th.resolved ? t('重新打开') : t('标记为已解决'),
                onClick: () => api().updateConversation(th.id, { resolved: !th.resolved })
              },
              {
                icon: <Download size={15} />,
                label: t('导出为 Markdown'),
                onClick: () => void api().exportConversation(th.id)
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
        {wide && (
          <button className="icon-btn" data-tip={t('关闭讨论串')} onClick={() => (setWide(false), onBack())}>
            <X size={16} />
          </button>
        )}
        {menu}
      </div>
      <PlanLine conv={th} defaultOpen={st === 'working'} />
      <Transcript conversation={th} compact header={<ThreadRoot thread={th} />} />
      <PermissionPrompts conversationId={th.id} />
      <Composer conversation={th} placeholder={t('在讨论串中回复…')} />
    </div>
  )
}

/** The request in the project chat that this thread grew out of, shown at its top like Claude's thread root. */
function ThreadRoot({ thread }: { thread: Conversation }) {
  const root = useApp((s) => {
    const p = s.projects.find((x) => x.id === thread.projectId)
    const list = (p && s.messages[p.conversationId]) || []
    const i = list.findIndex((m) => m.id === thread.anchorMessageId)
    for (let j = i - 1; j >= 0; j--) if (list[j].role === 'user' && !list[j].hidden) return list[j]
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
  empty,
  items,
  onOpen,
  collapsed,
  children
}: {
  title: string
  empty?: string
  items: Conversation[]
  onOpen: (id: string) => void
  collapsed?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(!collapsed)
  const count = children ? undefined : items.length
  return (
    <div className="thread-group">
      <button className="thread-group-head" onClick={() => setOpen(!open)}>
        <ChevronDown size={14} className={'chev' + (open ? '' : ' closed')} />
        <span>{title}</span>
        {count !== undefined && <span className="count">{count}</span>}
      </button>
      {open && (
        <div className="thread-group-body">
          {children ??
            (items.length ? items.map((th) => <ThreadRow key={th.id} th={th} onOpen={onOpen} />) : empty && <div className="thread-group-empty">{empty}</div>)}
        </div>
      )}
    </div>
  )
}

function ThreadRow({ th, onOpen }: { th: Conversation; onOpen: (id: string) => void }) {
  const st = threadState(th)
  const step = planHeadline(th)
  const progress = progressOf(th.checklist)
  // A message from another thread waiting to be handed over says so on the board.
  const waiting = useApp((s) => s.peerMessages.find((m) => m.toId === th.id && m.state === 'pending'))
  const from = useApp((s) => (waiting ? s.conversations.find((c) => c.id === waiting.fromId)?.title : undefined))
  return (
    <button className="thread-row" onClick={() => onOpen(th.id)}>
      <span className="text">
        <span className="title">
          {th.unread && <span className="dot unread" />}
          {th.title}
        </span>
        <span className="sub">{st === 'working' && step ? step : st === 'error' ? t('出错') : th.lastPreview ?? ''}</span>
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
    </button>
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
