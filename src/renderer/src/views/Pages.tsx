import { useEffect, useState } from 'react'
import { deleteChat, routeFor } from '../actions'
import { Check, CheckSquare, ChevronDown, Clock, Folder, FolderKanban, MessageCircle, Pause, Play, Plus, Search, Trash2 } from 'lucide-react'
import { searchable, type Conversation, type Project, type Routine, type Schedule, type SearchHit } from '@shared/model'
import { api, useApp } from '../store'
import { relTime } from '../util'
import { locale, t } from '../i18n'
import { confirmDialog } from '../components/Modal'
import { boardCount } from '../components/ProgressPanel'
import { groupByFolder } from '../folderGroups'

const WEEKDAY = [t('日'), t('一'), t('二'), t('三'), t('四'), t('五'), t('六')]

export function ProjectsPage() {
  const projects = useApp((s) => s.projects)
  const conversations = useApp((s) => s.conversations)
  const navigate = useApp((s) => s.navigate)
  const set = useApp((s) => s.set)
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const matching = projects
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const list = matching.filter((p) => !p.archived)
  const archived = matching.filter((p) => p.archived)
  const card = (p: Project) => {
    const threads = conversations.filter((c) => c.projectId === p.id && c.kind === 'thread')
    const working = threads.filter((t) => t.status === 'working').length
    const board = boardCount(p.progress)
    return (
      <button key={p.id} className={'card' + (p.archived ? ' archived' : '')} onClick={() => navigate({ view: 'project', projectId: p.id })}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FolderKanban size={15} className="muted" />
          <span className="title">{p.name}</span>
          {p.archived && (
            <span
              className="link small"
              style={{ marginLeft: 'auto' }}
              role="button"
              onClick={(e) => (e.stopPropagation(), void api().updateProject(p.id, { archived: false }))}
            >
              {t('恢复')}
            </span>
          )}
        </div>
        <div className="small muted" style={{ minHeight: 38 }}>
          {p.description || t('没有描述')}
        </div>
        {board.total > 0 && (
          <div className="progress-bar">
            <span style={{ width: `${(board.done / board.total) * 100}%` }} />
          </div>
        )}
        <div className="small muted">
          {threads.length} {' '}{t('个讨论串')}{working ? t(' · {0} 个进行中', working) : ''}
          {board.total > 0 ? t(' · 进度 {0}/{1}', board.done, board.total) : ''} {' '}{t('· 更新于')}{' '}{relTime(p.updatedAt)}
        </div>
      </button>
    )
  }
  return (
    <div className="scroll">
      <div className="page">
        <div className="page-head">
          <h1>{t('项目')}</h1>
          <button className="btn primary" onClick={() => set({ settingsOpen: 'new-project' })}>
            <Plus size={15} />
            {t('新建项目')}</button>
        </div>
        <label className="search" style={{ margin: '0 0 16px', height: 40 }}>
          <Search size={15} />
          <input placeholder={t('搜索项目…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {q && projects.length > 0 && !matching.length && <div className="empty small muted">{t('没有匹配的项目')}</div>}
        {projects.length === 0 && (
          <div className="empty">
            <FolderKanban size={24} />
            <div>{t('项目把一个主对话和多个讨论串组织在一起，适合长期推进的工作。')}</div>
            <button className="btn" onClick={() => set({ settingsOpen: 'new-project' })}>
              {t('创建第一个项目')}</button>
          </div>
        )}
        <div className="grid">{list.map(card)}</div>
        {archived.length > 0 && (
          <>
            <button className="section-toggle" onClick={() => setShowArchived(!showArchived)}>
              <ChevronDown size={14} className={'chev' + (showArchived ? '' : ' closed')} />
              {t('已归档')} <span className="muted">{archived.length}</span>
            </button>
            {showArchived && <div className="grid">{archived.map(card)}</div>}
          </>
        )}
      </div>
    </div>
  )
}

export function ChatsPage() {
  const conversations = useApp((s) => s.conversations)
  const navigate = useApp((s) => s.navigate)
  const [q, setQ] = useState(() => useApp.getState().search)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const list = conversations
    .filter((c) => c.kind === 'chat')
    .filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()) || c.lastPreview?.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const chosen = list.filter((c) => picked.has(c.id))
  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const stop = () => {
    setSelecting(false)
    setPicked(new Set())
  }
  const removeChosen = async () => {
    if (!chosen.length) return
    if (!(await confirmDialog(t('删除选中的 {0} 个对话？此操作无法撤销。', chosen.length)))) return
    for (const c of chosen) await api().deleteConversation(c.id)
    stop()
  }
  const removeOne = (c: Conversation) => deleteChat(c)
  return (
    <div className="scroll">
      <div className="page">
        <div className="page-head">
          <h1>{t('对话')}</h1>
          {list.length > 0 && !selecting && (
            <button className="btn" onClick={() => setSelecting(true)}>
              <CheckSquare size={15} />
              {t('选择')}</button>
          )}
          <button className="btn primary" onClick={() => navigate({ view: 'home' })}>
            <Plus size={15} />
            {t('新对话')}</button>
        </div>
        <label className="search" style={{ margin: '0 0 8px', height: 40 }}>
          <Search size={15} />
          <input placeholder={t('搜索对话…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {selecting && (
          <div className="select-bar">
            <button
              className="btn ghost"
              onClick={() => setPicked(chosen.length === list.length ? new Set() : new Set(list.map((c) => c.id)))}
            >
              {chosen.length === list.length ? t('取消全选') : t('全选')}</button>
            <span className="small muted">{t('已选 {0} 个', chosen.length)}</span>
            <span className="spacer" />
            <button className="btn danger" disabled={!chosen.length} onClick={() => void removeChosen()}>
              <Trash2 size={15} />
              {t('删除')}</button>
            <button className="btn ghost" onClick={stop}>
              {t('完成')}</button>
          </div>
        )}
        {!selecting && <MessageHits q={q} />}
        {!q && list.length === 0 && (
          <div className="empty">
            <MessageCircle size={24} />
            <div>{t('还没有对话。对话按工作文件夹分组列在这里；项目里的讨论在项目中。')}</div>
            <button className="btn" onClick={() => navigate({ view: 'home' })}>
              {t('开始新对话')}</button>
          </div>
        )}
        {list.length > 0 && !selecting && (
          <div className="small muted" style={{ margin: '8px 4px' }}>
            {q ? t('标题匹配的对话 · {0}', list.length) : t('共 {0} 个对话', list.length)}
          </div>
        )}
        {groupByFolder(list, useApp.getState().platform).map((g) => (
          <section key={g.key} className="chat-group">
            <div className="chat-group-head" data-tip={g.folder}>
              {g.folder ? <Folder size={14} /> : <MessageCircle size={14} />}
              <span>{g.name}</span>
              {g.folder && <span className="small muted chat-group-path">{g.folder}</span>}
            </div>
        {g.chats.map((c) => {
          const on = picked.has(c.id)
          return (
            <div className={'list-row chat-row' + (on ? ' picked' : '')} key={c.id}>
            <button
              key={c.id}
              className="chat-row-open"
              role={selecting ? 'checkbox' : undefined}
              aria-checked={selecting ? on : undefined}
              onClick={() => (selecting ? toggle(c.id) : navigate({ view: 'chat', conversationId: c.id }))}
            >
              {selecting ? (
                <span className={'check-box' + (on ? ' on' : '')}>{on && <Check size={12} />}</span>
              ) : (
                <MessageCircle size={16} className="muted" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{c.title}</div>
                <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.lastPreview}
                </div>
              </div>
              <span className="small muted">{relTime(c.updatedAt)}</span>
            </button>
            {!selecting && <button className="icon-btn" data-tip={t('删除对话')} aria-label={t('删除对话「{0}」', c.title)} onClick={() => void removeOne(c)}>
              <Trash2 size={16} />
            </button>}
            </div>
          )
        })}
          </section>
        ))}
      </div>
    </div>
  )
}

/** Matches inside messages, across chats, project chats and threads. */
function MessageHits({ q }: { q: string }) {
  const [hits, setHits] = useState<SearchHit[]>([])
  const conversations = useApp((s) => s.conversations)
  const projects = useApp((s) => s.projects)
  const navigate = useApp((s) => s.navigate)
  const setApp = useApp((s) => s.set)
  useEffect(() => {
    if (!searchable(q)) return setHits([])
    const t = setTimeout(() => void api().search(q).then(setHits), 200)
    return () => clearTimeout(t)
  }, [q])
  if (!hits.length) return null
  const open = (c: Conversation) => navigate(routeFor(c))
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="small muted" style={{ margin: '8px 4px' }}>
        {t('消息中的匹配 ·')}{' '}{hits.length}
      </div>
      {hits.map((h) => {
        const c = conversations.find((x) => x.id === h.conversationId)
        if (!c) return null
        const p = projects.find((x) => x.id === c.projectId)
        const where = c.kind === 'project' ? (p?.name ?? c.title) : p && c.kind === 'thread' ? `${p.name} · ${c.title}` : c.title
        return (
          <button
            key={h.messageId}
            className="list-row"
            onClick={() => {
              setApp({ focusMessage: h.messageId })
              open(c)
            }}
          >
            <Search size={15} className="muted" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{where}</div>
              <div className="small muted hit">
                {h.role === 'user' ? t('您：') : ''}
                <Highlight text={h.snippet} q={q} />
              </div>
            </div>
            <span className="small muted">{relTime(h.createdAt)}</span>
          </button>
        )
      })}
    </div>
  )
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase())
  if (i < 0) return <>{text}</>
  const n = q.trim().length
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + n)}</mark>
      {text.slice(i + n)}
    </>
  )
}

export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'once':
      return t('一次：{0}', new Date(s.at).toLocaleString(locale))
    case 'interval':
      return s.minutes % 60 === 0 ? t('每 {0} 小时', s.minutes / 60) : t('每 {0} 分钟', s.minutes)
    case 'daily': {
      const days = s.weekdays?.length && s.weekdays.length < 7 ? t('每周') + s.weekdays.map((d) => WEEKDAY[d]).join(t('、')) : t('每天')
      return `${days} ${s.time}`
    }
    case 'cron':
      return t('cron：{0}', s.expr)
  }
}

export function RoutinesPage() {
  const routines = useApp((s) => s.routines)
  const projects = useApp((s) => s.projects)
  const conversations = useApp((s) => s.conversations)
  const navigate = useApp((s) => s.navigate)
  const set = useApp((s) => s.set)
  const target = (r: Routine) =>
    projects.find((p) => p.id === r.target.projectId)?.name ??
    conversations.find((c) => c.id === r.target.conversationId)?.title ??
    t('每次新建对话')
  return (
    <div className="scroll">
      <div className="page">
        <div className="page-head">
          <h1>{t('定时任务')}</h1>
          <button className="btn primary" onClick={() => set({ settingsOpen: 'routine:new:' })}>
            <Plus size={15} />
            {t('新建定时任务')}</button>
        </div>
        {routines.length === 0 && (
          <div className="empty">
            <Clock size={24} />
            <div>{t('让 agent 按计划自动工作：每天早上汇总、每小时检查、到点提醒。')}</div>
          </div>
        )}
        {routines.map((r) => (
          <div key={r.id} className="list-row" style={{ cursor: 'default' }}>
            <Clock size={16} className="muted" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>
                <button onClick={() => set({ settingsOpen: `routine:${r.id}` })}>{r.name}</button>
              </div>
              <div className="small muted">
                {describeSchedule(r.schedule)} {' '}{t('· 发到')}{' '}{target(r)}
                {r.pausedByArchive ? t(' · 已暂停：项目已归档，恢复项目后继续') : !r.enabled ? t(' · 已暂停') : ''}
                {r.nextRunAt && r.enabled ? t(' · 下次 {0}', new Date(r.nextRunAt).toLocaleString(locale)) : ''}
                {r.lastError ? t(' · 上次失败：{0}', r.lastError) : r.lastRunAt ? t(' · 上次 {0}', relTime(r.lastRunAt)) : ''}
              </div>
            </div>
            {r.lastRunConversationId && (
              <button className="btn" onClick={() => navigate({ view: 'chat', conversationId: r.lastRunConversationId! })}>
                {t('查看结果')}</button>
            )}
            <button className="icon-btn" data-tip={t('立即运行')} onClick={() => api().runRoutineNow(r.id)}>
              <Play size={15} />
            </button>
            <button
              className="icon-btn"
              data-tip={r.enabled ? t('暂停') : t('启用')}
              onClick={() => api().saveRoutine({ ...r, enabled: !r.enabled })}
            >
              {r.enabled ? <Pause size={15} /> : <Play size={15} style={{ color: 'var(--green)' }} />}
            </button>
            <button
              className="icon-btn"
              data-tip={t('删除')}
              onClick={async () => (await confirmDialog(t('删除定时任务「{0}」？', r.name))) && api().deleteRoutine(r.id)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
