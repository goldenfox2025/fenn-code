import { useMemo, useState } from 'react'
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
  Archive
} from 'lucide-react'
import { searchable, type Conversation, type NotifyLevel, type Project } from '@shared/model'
import { api, useApp } from '../store'
import { initials } from '../util'
import { useMenu } from './Menu'
import { t } from '../i18n'
import { confirmDialog, promptDialog } from './Modal'
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
  const s = useApp()
  const width = usePaneWidth('sidebar')
  const [menu, openMenu] = useMenu({ align: 'left' })
  const q = s.search.trim().toLowerCase()
  const route = s.route

  const live = s.projects.filter((p) => !p.archived)
  const pinnedProjects = live.filter((p) => p.pinned)
  // Other projects, most recently active first (activity = its own chats and threads).
  const lastActive = (p: Project) =>
    Math.max(p.updatedAt, ...s.conversations.filter((c) => c.projectId === p.id || c.id === p.conversationId).map((c) => c.updatedAt))
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
  const matchingProjects = q ? s.projects.filter((p) => p.name.toLowerCase().includes(q)) : []

  const projectActivity = (p: Project) => {
    const threads = s.conversations.filter((c) => c.projectId === p.id && c.kind !== 'chat')
    if (threads.some((t) => t.status === 'working')) return 'working'
    if (threads.some((t) => t.status === 'waiting')) return 'waiting'
    if (threads.some((t) => t.unread)) return 'unread'
    return ''
  }

  const chatMenu = (el: HTMLElement, c: Conversation) =>
    openMenu(el, [
      {
        icon: <Pencil size={15} />,
        label: t('重命名'),
        onClick: async () => {
          const title = await promptDialog(t('重命名对话'), c.title)
          if (title && title !== c.title) void api().updateConversation(c.id, { title })
        }
      },
      {
        icon: c.pinned ? <PinOff size={15} /> : <Pin size={15} />,
        label: c.pinned ? t('取消置顶') : t('置顶'),
        onClick: () => api().updateConversation(c.id, { pinned: !c.pinned })
      },
      { separator: true },
      { icon: <Trash2 size={15} />, label: t('删除'), danger: true, onClick: () => removeChat(c) }
    ])

  const removeChat = async (c: Conversation) => {
    const kept = s.conversations.some((x) => x.parentId === c.id) ? ' ' + t('它的子对话会保留，成为独立的对话。') : ''
    if (!(await confirmDialog(t('删除「{0}」？此操作无法撤销。', c.title) + kept))) return
    void api().deleteConversation(c.id)
    if (route.view === 'chat' && route.conversationId === c.id) s.navigate({ view: 'home' })
  }

  // As in Claude: how to open it, pin, rename, notifications, settings; archive and delete apart.
  const projectMenu = (el: HTMLElement, p: Project) => {
    const level = p.notify ?? 'coordinator'
    openMenu(el, [
      {
        label: t('打开方式'),
        submenu: [
          { label: t('文件管理器'), disabled: !p.cwd, onClick: () => p.cwd && void api().openOutput(p.cwd) },
          { label: t('项目设置'), onClick: () => s.set({ settingsOpen: `project:${p.id}` }) }
        ]
      },
      { separator: true },
      { label: p.pinned ? t('取消置顶') : t('置顶'), shortcut: 'P', onClick: () => api().updateProject(p.id, { pinned: !p.pinned }) },
      {
        label: t('重命名'),
        shortcut: 'R',
        onClick: async () => {
          const name = await promptDialog(t('重命名项目'), p.name)
          if (name?.trim() && name.trim() !== p.name) void api().updateProject(p.id, { name: name.trim() })
        }
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
        onClick: async () => {
          if (!(await confirmDialog(t('删除项目「{0}」及其所有讨论串？项目内的普通对话会保留。', p.name)))) return
          void api().deleteProject(p.id)
          if (route.view === 'project' && route.projectId === p.id) s.navigate({ view: 'projects' })
        }
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
        data-tip={c.title}
      >
        <span className={'dot ' + (c.status === 'working' ? 'working' : c.status === 'waiting' ? 'waiting' : c.unread ? 'unread' : '')} />
        <span className="label">{c.title}</span>
        <span className="trail">
          <button className="icon-btn sm" data-focus-key={'chat-menu:' + c.id} onClick={(e) => (e.stopPropagation(), chatMenu(e.currentTarget, c))}>
            <MoreHorizontal size={15} />
          </button>
        </span>
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
        <span className="label">{p.name}</span>
        {act && <span className={'dot ' + act} />}
        <span className="trail">
          <button className="icon-btn sm" data-focus-key={'project-menu:' + p.id} onClick={(e) => (e.stopPropagation(), projectMenu(e.currentTarget, p))}>
            <MoreHorizontal size={15} />
          </button>
        </span>
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
        <button className="icon-btn" data-tip={t('收起侧栏 (Ctrl+B)')} onClick={() => s.set({ sidebarOpen: false })}>
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
              {q && !chats.length && <div className="small muted" style={{ padding: '4px 10px' }}>{t('没有匹配的对话标题')}</div>}
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
          <span className="avatar">{initials(s.settings.userName)}</span>
          <span className="label" style={{ flex: 1, textAlign: 'left' }}>
            {s.settings.userName || t('您')} <span className="muted">{t('· 本地')}</span>
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
