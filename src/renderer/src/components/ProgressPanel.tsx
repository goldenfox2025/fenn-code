import { useState } from 'react'
import { CheckCircle2, Circle, CircleAlert, CircleDot, MoreHorizontal, Pencil, Plus, Trash2, Check, X } from 'lucide-react'
import type { Conversation, Project, ProgressItem, ProgressPatch, ProgressStatus } from '@shared/model'
import { api, toast, useApp, toastError } from '../store'
import { Dropdown, useMenu } from './Menu'
import { confirmDialog, EscLayer } from './Modal'
import { t } from '../i18n'

export const STATUS_TEXT: Record<ProgressStatus, string> = {
  todo: t('未开始'),
  doing: t('进行中'),
  blocked: t('受阻'),
  done: t('已完成')
}

/** Done and total, counting tasks (or the milestone itself when it has none). */
export function boardCount(items: ProgressItem[] = []): { done: number; total: number } {
  const leaves = items.filter((m) => !m.suggested).flatMap((m) => (m.children?.length ? m.children.filter((c) => !c.suggested) : [m]))
  return { done: leaves.filter((x) => x.status === 'done').length, total: leaves.length }
}

/** The first unfinished milestone, for a one-line summary. */
export function nextMilestone(items: ProgressItem[] = []): ProgressItem | undefined {
  return items.find((m) => !m.suggested && m.status !== 'done')
}

export function StatusIcon({ status, size = 16 }: { status: ProgressStatus; size?: number }) {
  if (status === 'done') return <CheckCircle2 size={size} className="ps done" />
  if (status === 'doing') return <CircleDot size={size} className="ps doing" />
  if (status === 'blocked') return <CircleAlert size={size} className="ps blocked" />
  return <Circle size={size} className="ps todo" />
}

const CYCLE: Record<ProgressStatus, ProgressStatus> = { todo: 'doing', doing: 'done', blocked: 'doing', done: 'todo' }

type Draft = ProgressPatch & { mode: 'new' | 'edit' }

export function ProgressPanel({ project }: { project: Project }) {
  const items = project.progress ?? []
  const conversations = useApp((s) => s.conversations)
  const navigate = useApp((s) => s.navigate)
  const [menu, openMenu] = useMenu({ align: 'right' })
  const [draft, setDraft] = useState<Draft | null>(null)

  const save = async (patch: ProgressPatch) => {
    try {
      await api().updateProgress(project.id, patch)
    } catch (e) {
      toastError(e)
    }
  }
  const remove = async (x: ProgressItem) => {
    if (x.children?.length && !(await confirmDialog(t('删除里程碑「{0}」及其 {1} 个任务？', x.title, x.children.length)))) return
    void api().deleteProgress(project.id, x.id)
  }
  const open = (c: Conversation) =>
    c.kind === 'thread' ? navigate({ view: 'project', projectId: project.id, threadId: c.id }) : navigate({ view: 'chat', conversationId: c.id })

  const suggested = items.filter((m) => m.suggested)
  const board = items.filter((m) => !m.suggested)
  const { done, total } = boardCount(items)

  const itemMenu = (el: HTMLElement, x: ProgressItem, milestone: boolean) =>
    openMenu(el, [
      { icon: <Pencil size={15} />, label: t('编辑'), onClick: () => setDraft({ mode: 'edit', id: x.id, title: x.title, status: x.status, due: x.due ?? '', note: x.note ?? '' }) },
      ...(milestone ? [{ icon: <Plus size={15} />, label: t('添加任务'), onClick: () => setDraft({ mode: 'new', parentId: x.id, title: '', status: 'todo' as const }) }] : []),
      { heading: t('状态') },
      ...(['todo', 'doing', 'blocked', 'done'] as ProgressStatus[]).map((st) => ({
        icon: <StatusIcon status={st} size={15} />,
        label: STATUS_TEXT[st],
        checked: x.status === st,
        onClick: () => void save({ id: x.id, status: st })
      })),
      { separator: true },
      { icon: <Trash2 size={15} />, label: t('删除'), danger: true, onClick: () => void remove(x) }
    ])

  const row = (x: ProgressItem, milestone: boolean) => {
    const links = (x.links ?? []).map((id) => conversations.find((c) => c.id === id)).filter((c): c is Conversation => !!c)
    const late = x.due && x.status !== 'done' && x.due < new Date().toISOString().slice(0, 10)
    return (
      <div className={'progress-row' + (milestone ? ' milestone' : ' task') + (x.status === 'done' ? ' is-done' : '')}>
        <button
          className="status-btn"
          data-tip={t('{0}（点击切换）', STATUS_TEXT[x.status])}
          onClick={() => void save({ id: x.id, status: CYCLE[x.status] })}
        >
          <StatusIcon status={x.status} size={milestone ? 17 : 15} />
        </button>
        <div className="progress-text">
          <div className="progress-title" onDoubleClick={() => setDraft({ mode: 'edit', id: x.id, title: x.title, status: x.status, due: x.due ?? '', note: x.note ?? '' })}>
            {x.title}
          </div>
          {(x.note || x.due || links.length > 0) && (
            <div className="progress-meta">
              {x.due && <span className={'due' + (late ? ' late' : '')}>{t('截止 {0}', x.due)}</span>}
              {links.map((c) => (
                <button key={c.id} className="link-chip" data-tip={c.title} onClick={() => open(c)}>
                  {c.title}
                </button>
              ))}
              {x.note && <span className="note">{x.note}</span>}
            </div>
          )}
        </div>
        <button className="icon-btn sm" data-focus-key={'progress-menu:' + x.id} onClick={(e) => itemMenu(e.currentTarget, x, milestone)}>
          <MoreHorizontal size={15} />
        </button>
      </div>
    )
  }

  const form = draft && (
    <div className="progress-form">
      <EscLayer onClose={() => setDraft(null)} />
      <input
        className="input"
        autoFocus
        placeholder={draft.parentId ? t('任务名称') : t('里程碑名称')}
        value={draft.title ?? ''}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        onKeyDown={(e) => e.key === 'Enter' && draft.title?.trim() && void submit()}
      />
      <div className="progress-form-row">
        <Dropdown
          value={draft.status ?? 'todo'}
          onChange={(v) => setDraft({ ...draft, status: v as ProgressStatus })}
          options={(['todo', 'doing', 'blocked', 'done'] as ProgressStatus[]).map((st) => ({ value: st, label: STATUS_TEXT[st] }))}
        />
        <input className="input" type="date" data-tip={t('截止日期（可选）')} value={draft.due ?? ''} onChange={(e) => setDraft({ ...draft, due: e.target.value })} />
      </div>
      <input className="input" placeholder={t('备注（可选）')} value={draft.note ?? ''} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      <div className="modal-actions">
        <button className="btn" onClick={() => setDraft(null)}>
          {t('取消')}
        </button>
        <button className="btn primary" disabled={!draft.title?.trim()} onClick={() => void submit()}>
          {draft.mode === 'new' ? t('添加') : t('保存')}
        </button>
      </div>
    </div>
  )

  async function submit() {
    if (!draft) return
    const { mode, ...patch } = draft
    if (mode === 'new') delete patch.id
    await save(patch)
    setDraft(null)
  }

  return (
    <div className="thread-list progress-board">
      <div className="panel-welcome progress-head">
        <div className="muted small">
          {total
            ? t('已完成 {0}/{1}', done, total)
            : t('用里程碑和任务跟踪项目进展。agent 完成工作时会更新这里，您也可以直接修改。')}
        </div>
        {total > 0 && (
          <div className="progress-bar">
            <span style={{ width: `${(done / total) * 100}%` }} />
          </div>
        )}
      </div>

      {suggested.length > 0 && (
        <div className="progress-suggested">
          <div className="small muted" style={{ padding: '4px 10px' }}>
            {t('建议记入进度')}
          </div>
          {suggested.map((x) => (
            <div key={x.id} className="progress-row suggested">
              <StatusIcon status={x.status} size={15} />
              <div className="progress-text">
                <div className="progress-title">{x.title}</div>
              </div>
              <button className="icon-btn sm" data-tip={t('采纳')} onClick={() => void save({ id: x.id, suggested: false })}>
                <Check size={15} />
              </button>
              <button className="icon-btn sm" data-tip={t('忽略')} onClick={() => void api().deleteProgress(project.id, x.id)}>
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {board.map((m) => (
        <div key={m.id} className="progress-group">
          {draft?.mode === 'edit' && draft.id === m.id ? form : row(m, true)}
          {(m.children ?? [])
            .filter((c) => !c.suggested)
            .map((c) => (
              <div key={c.id}>{draft?.mode === 'edit' && draft.id === c.id ? form : row(c, false)}</div>
            ))}
          {draft?.mode === 'new' && draft.parentId === m.id && form}
        </div>
      ))}

      {draft?.mode === 'new' && !draft.parentId ? (
        form
      ) : (
        <div style={{ padding: 8 }}>
          <button className="btn" onClick={() => setDraft({ mode: 'new', title: '', status: 'todo' })}>
            <Plus size={14} />
            {t('添加里程碑')}
          </button>
        </div>
      )}
      {menu}
    </div>
  )
}
