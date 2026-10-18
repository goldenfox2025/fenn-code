import { useMemo, useState } from 'react'
import { deleteChat, deleteProject, openInFileManager, routeFor } from '../actions'
import {
  ArrowLeft,
  ArrowRight,
  ChevronsUpDown,
  Clock,
  FolderKanban,
  Menu as MenuIcon,
  MessagesSquare,
  MoreHorizontal,
  PanelLeft,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  Pencil,
  User
} from 'lucide-react'
import { searchable, type Conversation, type NotifyLevel, type Project } from '@shared/model'
import { useShallow } from 'zustand/react/shallow'
import { api, toastError, useApp } from '../store'
import { initials } from '../util'
import { useMenu } from './Menu'
import { t } from '../i18n'
import { RenameInput, useRenaming } from './InlineRename'
import { groupByFolder, isNested } from '../folderGroups'
import { ResizeHandle, paneStyle, usePaneWidth } from './ResizeHandle'

/** A project's notification levels, as Claude words them. */
const NOTIFY_LEVELS = (): { id: NotifyLevel; label: string; sub?: string; short: string }[] => [
  { id: 'all', label: t('所有新消息'), sub: t('包含每个讨论串中的回复'), short: t('所有') },
  { id: 'coordinator', label: t('协调者与 @提及'), sub: t('主对话以及所有需要您处理的内容'), short: t('协调者') },
  { id: 'mentions', label: t('仅 @提及'), short: t('仅提及') },
  { id: 'none', label: t('无'), short: t('无') }
]

export function Sidebar() {
  // Only what the sidebar shows: streaming replies (messages) don't redraw it.
  const s = useApp(
    useShallow((x) => ({
      projects: x.projects, conversations: x.conversations, routines: x.routines, search: x.search, route: x.route,
      sidebarOpen: x.sidebarOpen, platform: x.platform, history: x.history, future: x.future, settings: x.settings,
      set: x.set, navigate: x.navigate, back: x.back, forward: x.forward
    }))
  )
  const width = usePaneWidth('sidebar')
  const [menu, openMenu] = useMenu({ align: 'left' })
  const q = s.search.trim().toLowerCase()
  const userName = typeof s.settings.userName === 'string' ? s.settings.userName.trim() : ''
  const route = s.route

  const live = s.projects.filter((p) => !p.archived)
  const pinnedProjects = live.filter((p) => p.pinned)
  // One pass over the conversations: each project's latest activity and what its threads are doing.
  const stats = useMemo(() => projectStats(s.conversations), [s.conversations])
  // Other projects, most recently active first (activity = its own chats and threads).
  const lastActive = (p: Project) => Math.max(p.updatedAt, stats.get(p.id)?.updatedAt ?? 0)
  const recentProjects = live
    .filter((p) => !p.pinned)
    .sort((a, b) => lastActive(b) - lastActive(a))
    .slice(0, 5)
  const chats = useMemo(
    () =>
      s.conversations
        .filter((c) => c.kind === 'chat')
        .filter((c) => !q || c.title.toLowerCase().includes(q) || c.lastPreview?.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [s.conversations, q]
  )
  const pinnedChats = chats.filter((c) => c.pinned)
  const unpinned = chats.filter((c) => !c.pinned)
  const platform = useApp((x) => x.platform)
  // Below the projects, chats are grouped by the folder they work in.
  const groups = useMemo(() => groupByFolder(unpinned, platform), [unpinned, platform])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const SHOWN = 8
  const matchingProjects = q ? s.projects.filter((p) => !p.archived && p.name.toLowerCase().includes(q)) : []
  // Threads live in their projects, but searching finds them by title too.
  const matchingThreads = useMemo(() => {
    if (!q) return []
    const live = new Map(s.projects.filter((p) => !p.archived).map((p) => [p.id, p.name]))
    return s.conversations
      .filter((c) => c.kind === 'thread' && c.projectId && live.has(c.projectId) && c.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((c) => ({ c, project: live.get(c.projectId!)! }))
  }, [s.conversations, s.projects, q])

  const projectActivity = (p: Project) => stats.get(p.id)?.activity ?? ''

  // Renaming happens in the row itself: a double click on the name, or 重命名 in its menu.
  const rn = useRenaming()
  const renameChat = (c: Conversation, title: string | null) => {
    rn.stop()
    if (title) void api().updateConversation(c.id, { title }).catch(toastError)
  }
  const renameProject = (p: Project, name: string | null) => {
    rn.stop()
    if (name) void api().updateProject(p.id, { name }).catch(toastError)
  }
  /** A row's name, or the field renaming it. */
  const rowTitle = (key: string, text: string, done: (name: string | null) => void) =>
    rn.editing === key ? (
      <RenameInput value={text} onDone={done} className="nav-rename" />
    ) : (
      <span className="label" {...rn.onTitle(key)}>
        {text}
      </span>
    )

  const chatMenu = (el: HTMLElement, c: Conversation) =>
    openMenu(el, [
      {
        icon: <Pencil size={15} />,
        label: t('重命名'),
        onClick: () => rn.start('chat:' + c.id)
      },
      {
        icon: c.pinned ? <PinOff size={15} /> : <Pin size={15} />,
        label: c.pinned ? t('取消置顶') : t('置顶'),
        onClick: () => void api().updateConversation(c.id, { pinned: !c.pinned }).catch(toastError)
      },
      { separator: true },
      { icon: <Trash2 size={15} />, label: t('删除'), danger: true, onClick: () => void deleteChat(c) }
    ])

  // As in Claude: how to open it, pin, rename, notifications, settings; archive and delete apart.
  const projectMenu = (el: HTMLElement, p: Project) => {
    const level = p.notify ?? 'coordinator'
    openMenu(el, [
      {
        label: t('打开方式'),
        submenu: [
          { label: t('文件管理器'), disabled: !p.cwd, onClick: () => p.cwd && void openInFileManager(p.cwd) },
          { label: t('项目设置'), onClick: () => s.set({ settingsOpen: `project:${p.id}` }) }
        ]
      },
      { separator: true },
      { label: p.pinned ? t('取消置顶') : t('置顶'), shortcut: 'P', onClick: () => api().updateProject(p.id, { pinned: !p.pinned }) },
      {
        label: t('重命名'),
        shortcut: 'R',
        onClick: () => rn.start('project:' + p.id)
      },
      {
        label: t('通知'),
        hint: NOTIFY_LEVELS().find((n) => n.id === level)?.short,
        submenu: NOTIFY_LEVELS().map((n) => ({
          label: n.label,
          sub: n.sub,
          checked: n.id === level,
          onClick: () => api().updateProject(p.id, { notify: n.id })
        }))
      },
      { label: t('设置'), shortcut: 'S', onClick: () => s.set({ settingsOpen: `project:${p.id}` }) },
      { separator: true },
      { label: t('归档'), shortcut: 'A', onClick: () => api().updateProject(p.id, { archived: true, pinned: false }) },
      {
        label: t('删除'),
        shortcut: 'D',
        danger: true,
        onClick: () => void deleteProject(p)
      }
    ])
  }

  // Plain render functions, not components: a component declared in here would be a new type on
  // every render, remounting each row and detaching the 「…」 button a menu is anchored to.
  const chatRow = (c: Conversation) => {
    const selected = route.view === 'chat' && route.conversationId === c.id
    const nested = !q && isNested(c, chats)
    return (
      <div
        key={c.id}
        className={'nav-item' + (selected ? ' selected' : '') + (nested ? ' nested' : '')}
        role="button"
        onClick={() => s.navigate({ view: 'chat', conversationId: c.id })}
        data-tip={rn.editing === 'chat:' + c.id ? undefined : c.title}
      >
        <span className={'dot ' + (c.status === 'working' ? 'working' : c.status === 'waiting' ? 'waiting' : c.unread ? 'unread' : '')} />
        {rowTitle('chat:' + c.id, c.title, (title) => renameChat(c, title))}
        {rn.editing !== 'chat:' + c.id && (
          <span className="trail">
            <button className="icon-btn sm" data-focus-key={'chat-menu:' + c.id} onClick={(e) => (e.stopPropagation(), chatMenu(e.currentTarget, c))}>
              <MoreHorizontal size={15} />
            </button>
          </span>
        )}
      </div>
    )
  }

  const projectRow = (p: Project) => {
    const selected = route.view === 'project' && route.projectId === p.id
    const act = projectActivity(p)
    return (
      <div
        key={p.id}
        className={'nav-item' + (selected ? ' selected' : '')}
        role="button"
        onClick={() => s.navigate({ view: 'project', projectId: p.id })}
        onContextMenu={(e) => {
          e.preventDefault()
          projectMenu(e.currentTarget.querySelector<HTMLElement>('.trail .icon-btn') ?? e.currentTarget, p)
        }}
      >
        <FolderKanban size={15} style={{ flex: 'none' }} />
        {rowTitle('project:' + p.id, p.name, (name) => renameProject(p, name))}
        {act && <span className={'dot ' + act} />}
        {rn.editing !== 'project:' + p.id && (
          <span className="trail">
            <button className="icon-btn sm" data-focus-key={'project-menu:' + p.id} onClick={(e) => (e.stopPropagation(), projectMenu(e.currentTarget, p))}>
              <MoreHorizontal size={15} />
            </button>
          </span>
        )}
      </div>
    )
  }

  return (
    <aside className={'sidebar' + (s.sidebarOpen ? '' : ' closed') + (width ? ' sized' : '')} style={paneStyle('sidebar', width)}>
      <ResizeHandle pane="sidebar" edge="right" onCollapse={() => s.set({ sidebarOpen: false })} />
      <div className="sidebar-top drag">
        {s.platform !== 'darwin' && (
          <button className="icon-btn" data-tip={t('菜单')} onClick={() => s.set({ settingsOpen: 'general' })}>
            <MenuIcon size={17} />
          </button>
        )}
        <button className="icon-btn" data-tip={t('收起侧栏 ({0})', s.platform === 'darwin' ? '⌘B' : 'Ctrl+B')} onClick={() => s.set({ sidebarOpen: false })}>
          <PanelLeft size={17} />
        </button>
        <button className="icon-btn" data-tip={t('后退')} disabled={!s.history.length} onClick={s.back}>
          <ArrowLeft size={17} />
        </button>
        <button className="icon-btn" data-tip={t('前进')} disabled={!s.future.length} onClick={s.forward}>
          <ArrowRight size={17} />
        </button>
      </div>

      <label className="search">
        <Search size={15} />
        <input placeholder={t('搜索')} value={s.search} onChange={(e) => s.set({ search: e.target.value })} />
      </label>

      <div className="sidebar-scroll">
        <nav className="nav">
          <button
            className={'nav-item' + (route.view === 'home' ? ' selected' : '')}
            onClick={() => s.navigate({ view: 'home' })}
          >
            <Plus size={17} />
            <span className="label">{t('新建')}</span>
          </button>
          <button
            className={'nav-item' + (route.view === 'projects' ? ' selected' : '')}
            onClick={() => s.navigate({ view: 'projects' })}
          >
            <FolderKanban size={17} />
            <span className="label">{t('项目')}</span>
          </button>
          <button
            className={'nav-item' + (route.view === 'chats' ? ' selected' : '')}
            onClick={() => s.navigate({ view: 'chats' })}
          >
            <MessagesSquare size={17} />
            <span className="label">{t('对话')}</span>
          </button>
          <button
            className={'nav-item' + (route.view === 'routines' ? ' selected' : '')}
            onClick={() => s.navigate({ view: 'routines' })}
          >
            <Clock size={17} />
            <span className="label">{t('定时任务')}</span>
            {s.routines.some((r) => r.enabled) && <span className="badge">{s.routines.filter((r) => r.enabled).length}</span>}
          </button>
        </nav>

        {q && matchingProjects.length > 0 && (
          <>
            <div className="section-head">{t('项目')}</div>
            <nav className="nav">
              {matchingProjects.map((p) => projectRow(p))}
            </nav>
          </>
        )}

        {!q && (pinnedProjects.length > 0 || pinnedChats.length > 0) && (
          <>
            <div className="section-head">{t('已置顶')}</div>
            <nav className="nav">
              {pinnedProjects.map((p) => projectRow(p))}
              {pinnedChats.map((c) => chatRow(c))}
            </nav>
          </>
        )}

        {!q && recentProjects.length > 0 && (
          <>
            <div className="section-head">
              <span className="grow link" role="button" onClick={() => s.navigate({ view: 'projects' })}>
                {t('项目')}
              </span>
            </div>
            <nav className="nav recent-projects">
              {recentProjects.map((p) => projectRow(p))}
            </nav>
          </>
        )}

        {!q &&
          groups.map((g) => {
            const open = expanded.has(g.key)
            return (
              <div key={g.key} className="folder-group">
                <div className="section-head folder-head" data-tip={g.folder}>
                  <span className="grow">{g.name}</span>
                  <button
                    className="icon-btn sm"
                    data-tip={g.folder ? t('在 {0} 中新建对话', g.name) : t('新对话')}
                    onClick={() => s.navigate({ view: 'home', folder: g.folder })}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <nav className="nav">
                  {(open ? g.chats : g.chats.slice(0, SHOWN)).map((c) => chatRow(c))}
                  {g.chats.length > SHOWN && (
                    <button
                      className="nav-item more-row"
                      onClick={() => setExpanded((cur) => {
                        const next = new Set(cur)
                        if (open) next.delete(g.key)
                        else next.add(g.key)
                        return next
                      })}
                    >
                      <span className="label">{open ? t('收起') : t('显示全部（{0}）', g.chats.length)}</span>
                    </button>
                  )}
                </nav>
              </div>
            )
          })}

        {q && (
          <>
            <div className="section-head">
              <span className="grow">{t('搜索结果')}</span>
            </div>
            <nav className="nav">
              {chats.map((c) => chatRow(c))}
              {matchingThreads.map(({ c, project }) => (
                <div
                  key={c.id}
                  className={'nav-item' + (route.view === 'project' && route.threadId === c.id ? ' selected' : '')}
                  role="button"
                  onClick={() => s.navigate(routeFor(c))}
                  data-tip={`${project} · ${c.title}`}
                >
                  <MessagesSquare size={15} style={{ flex: 'none' }} />
                  {rowTitle('thread:' + c.id, c.title, (title) => renameChat(c, title))}
                  <span className="muted small thread-hit-project">{project}</span>
                </div>
              ))}
              {q && !chats.length && !matchingThreads.length && <div className="small muted" style={{ padding: '4px 10px' }}>{t('没有匹配的对话标题')}</div>}
              {searchable(q) && (
                <button className="nav-item" onClick={() => s.navigate({ view: 'chats' })}>
                  <Search size={15} />
                  <span className="label">{t('在所有消息里搜索「')}{s.search.trim()}{t('」')}</span>
                </button>
              )}
            </nav>
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="user-btn" onClick={() => s.set({ settingsOpen: 'general' })}>
          {/* No name given: a plain avatar and 「本地」, never 「您」 as if it were a name. */}
          <span className="avatar">{userName ? initials(userName) : <User size={14} />}</span>
          <span className="label" style={{ flex: 1, textAlign: 'left' }}>
            {userName ? (
              <>
                {userName} <span className="muted">{t('· 本地')}</span>
              </>
            ) : (
              t('本地')
            )}
          </span>
          <ChevronsUpDown size={14} className="muted" />
        </button>
        <button className="icon-btn" data-tip={t('设置')} onClick={() => s.set({ settingsOpen: 'general' })}>
          <Settings size={16} />
        </button>
      </div>
      {menu}
    </aside>
  )
}

type Activity = '' | 'unread' | 'waiting' | 'working'
const RANK: Record<Activity, number> = { '': 0, unread: 1, waiting: 2, working: 3 }

/** Per project: the latest update among its conversations, and the busiest state of its threads. */
function projectStats(conversations: Conversation[]): Map<string, { updatedAt: number; activity: Activity }> {
  const out = new Map<string, { updatedAt: number; activity: Activity }>()
  for (const c of conversations) {
    if (!c.projectId) continue
    const st = out.get(c.projectId) ?? { updatedAt: 0, activity: '' as Activity }
    st.updatedAt = Math.max(st.updatedAt, c.updatedAt)
    if (c.kind !== 'chat') {
      const a: Activity = c.status === 'working' ? 'working' : c.status === 'waiting' ? 'waiting' : c.unread ? 'unread' : ''
      if (RANK[a] > RANK[st.activity]) st.activity = a
    }
    out.set(c.projectId, st)
  }
  return out
}
