import { useEffect, useRef, useState } from 'react'
import type { DeletionPlan, DeletionTarget } from '@shared/model'
import { errorText, plainError } from '@shared/errors'
import { api } from '../store'
import { t } from '../i18n'
import { Overlay } from './Modal'
import { flushFileEdits } from './FilesPane'

interface Request { plan: DeletionPlan; done: (deleted: boolean) => void }
let show: ((request: Request) => void) | undefined
const keepSelection = (plan: DeletionPlan, values: Iterable<string>) => {
  const next = new Set([...values].filter(id => plan.folders.some(folder => folder.id === id && folder.state === 'available')))
  let changed = true
  while (changed) {
    changed = false
    for (const folder of plan.folders) if (next.has(folder.id) && folder.requiredFolderIds?.some(id => !next.has(id))) { next.delete(folder.id); changed = true }
  }
  return next
}

/** Every user-facing deletion, including bulk deletion, reviews the same folder plan. */
export async function deleteItemsDialog(targets: DeletionTarget[]): Promise<boolean> {
  const plan = await api().deletionPlan(targets)
  if (!plan.items.length) return true
  if (!show) throw new Error(t('删除界面尚未准备好，请重试。'))
  return new Promise(done => show!({ plan, done }))
}

export function DeleteItemsHost() {
  const [request, setRequest] = useState<Request | null>(null)
  const active = useRef<Request | null>(null)
  const [plan, setPlan] = useState<DeletionPlan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    show = next => {
      if (active.current) return next.done(false)
      active.current = next; setRequest(next); setPlan(next.plan); setError(''); setBusy(false)
      setSelected(keepSelection(next.plan, next.plan.folders.filter(folder => folder.state === 'available' && folder.automatic).map(folder => folder.id)))
    }
    return () => { show = undefined; active.current?.done(false) }
  }, [])
  if (!request || !plan) return null
  const finish = (deleted: boolean) => { active.current = null; setRequest(null); request.done(deleted) }
  const submit = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (!(await flushFileEdits())) throw new Error(t('请先处理尚未保存或冲突的文件，再删除。'))
      await api().deleteSelection(plan.targets, plan.revision, [...selected])
      finish(true)
    } catch (error) {
      setError(plainError(errorText(error)))
      const latest = await api().deletionPlan(plan.targets).catch(() => null)
      if (latest) {
        setPlan(latest)
        setSelected(before => keepSelection(latest, before))
      }
    } finally { setBusy(false) }
  }
  const title = plan.items.length === 1 ? t('删除「{0}」？', plan.items[0].title) : t('删除选中的 {0} 项？', plan.items.length)
  return <Overlay label={title} onClose={() => !busy && finish(false)} initialFocus=".deletion-cancel">
    <div className="modal confirm deletion-confirm" tabIndex={-1} aria-busy={busy}>
      <h2 data-tip={title}>{title}</h2>
      <div className="deletion-body">
        <p>{plan.items.some(item => item.kind === 'project') ? t('项目及其讨论串的记录将删除，无法在应用内恢复。') : t('所选对话的记录将删除，无法在应用内恢复。')}</p>
        {!!plan.retainedConversations && <p className="small muted">{t('{0} 个子对话或普通对话会保留。', plan.retainedConversations)}</p>}
        {!!plan.routinesToDisable && <p className="small muted">{t('{0} 个关联定时任务将停用。', plan.routinesToDisable)}</p>}
        {!!plan.folders.length && <div className="deletion-folders">
          {plan.folders.map(folder => <label className="deletion-folder" key={folder.id}>
            <input type="checkbox" checked={selected.has(folder.id)} disabled={busy || folder.state !== 'available'} onChange={event => setSelected(previous => {
              const next = new Set(previous)
              const add = (id: string) => {
                if (next.has(id)) return
                next.add(id); plan.folders.find(folder => folder.id === id)?.requiredFolderIds?.forEach(add)
              }
              if (event.target.checked) add(folder.id)
              else {
                next.delete(folder.id)
              }
              return keepSelection(plan, next)
            })} />
            <span>
              <span className="deletion-folder-title">{folder.state === 'available' ? t('一并移到回收站') : t('保留文件夹')}</span>
              <span className="deletion-folder-path" dir="auto">{folder.path}</span>
              <span className="deletion-folder-note">{folder.state === 'shared' ? t('仍被其他对话或项目使用，将保留。') : folder.state === 'protected' ? t('这是公共位置或应用数据目录，将保留。') : folder.state === 'missing' ? t('目录不存在或无法读取。') : folder.automatic ? t('由 Fenn Code 自动创建，文件可从回收站恢复。') : t('默认保留，勾选后才会移到回收站。')}</span>
              {!!folder.requiredFolderIds?.length && <span className="deletion-folder-note">{t('选择此项会同时选择关联的独立工作区。')}</span>}
            </span>
          </label>)}
        </div>}
        {error && <p className="deletion-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button className="btn confirm-cancel deletion-cancel" disabled={busy} onClick={() => finish(false)}>{t('取消')}</button>
        <button className="btn danger-solid" disabled={busy} onClick={() => void submit()}>{busy ? t('删除中…') : t('删除')}</button>
      </div>
    </div>
  </Overlay>
}
