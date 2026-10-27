import { useEffect, useRef, useState } from 'react'
import { NotebookText, Pencil, Plus, Trash2 } from 'lucide-react'
import type { MemoryEntry } from '@shared/model'
import type { MemoryDraft, MemoryInput as Input, MemorySkill } from '@shared/memoryInput'
import { MemoryInput, pendingMemoryDraft, clearMemoryDraft } from './MemoryInput'

export interface MemoryService {
  list(scope: string): Promise<MemoryEntry[]>
  save(scope: string, entry: { name: string; description: string; type?: string; body: string }): Promise<unknown>
  remove(scope: string, name: string): Promise<unknown>
  skills(scope: string): Promise<MemorySkill[]>
  compose(scope: string, input: Input): Promise<MemoryDraft>
}
export function MemoryManager(props: { scope: string; version?: number; service: MemoryService; translate?: (text: string) => string }) {
  return <ScopedMemoryManager key={props.scope} {...props} />
}
function ScopedMemoryManager({ scope, version = 0, service, translate: t = text => text }: { scope: string; version?: number; service: MemoryService; translate?: (text: string) => string }) {
  const request = useRef(0), live = useRef(true)
  const container = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<MemoryEntry | 'new' | null>(() => { const draft = pendingMemoryDraft(service, scope); return draft ? draft.original || 'new' : null })
  const [expanded, setExpanded] = useState<string | null>(null), [removing, setRemoving] = useState<string | null>(null)
  const reload = async () => {
    const stamp = ++request.current
    try { const items = await service.list(scope); if (live.current && stamp === request.current) { setEntries(items); setError('') } }
    catch (cause) { if (live.current && stamp === request.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { live.current = true; return () => { live.current = false; request.current++ } }, [scope])
  useEffect(() => { void reload() }, [scope, version])
  const start = (entry?: MemoryEntry) => { clearMemoryDraft(service, scope); setError(''); setRemoving(null); setEditing(entry || 'new') }
  return <div className="memory-manager" ref={container}>
    {editing ? <MemoryInput key={editing === 'new' ? 'new' : editing.name} scope={scope} original={editing === 'new' ? undefined : editing} service={service} translate={t} onCancel={() => { setEditing(null); setError(''); requestAnimationFrame(() => container.current?.querySelector<HTMLButtonElement>('.memory-empty .btn,.memory-list-tools .btn')?.focus({preventScroll:true})) }} onSaved={name => { setEditing(null); setExpanded(name); void reload() }} /> : <>
      {error ? <div className="memory-error" role="alert">{error}<button className="btn" onClick={() => void reload()}>{t('重试')}</button></div> : entries === null ? <p className="memory-note" role="status">{t('正在加载记忆…')}</p> : !entries.length ? <div className="memory-empty">
        <p>{t('偏好、决定和约定会保留在这里，随时可以修改或删除。')}</p><button className="btn" onClick={() => start()}><Plus size={14} />{t('添加记忆')}</button>
      </div> : <>
        <div className="memory-list-tools"><span>{t('长期保留的事实与偏好')}</span><button className="btn" onClick={() => start()}><Plus size={14} />{t('添加记忆')}</button></div>
        <div className="memory-list">{entries.map(entry => <section className="memory-fact" key={entry.name}>
          <button className="memory-fact-toggle" aria-expanded={expanded === entry.name} onClick={() => { setExpanded(expanded === entry.name ? null : entry.name); setRemoving(null) }}><NotebookText size={16} /><span><strong>{entry.description || entry.name}</strong><small>{({ user: t('偏好'), feedback: t('工作方式'), project: t('事实'), reference: t('参考资料') } as Record<string, string>)[entry.type] || t('记忆')} · {new Date(entry.updatedAt).toLocaleDateString()}</small></span></button>
          {expanded === entry.name && <div className="memory-fact-body"><p>{entry.body}</p>{removing === entry.name ? <div className="memory-delete" role="alert"><span>{t('删除这条记忆？')}</span><button className="btn" onClick={() => setRemoving(null)}>{t('保留')}</button><button className="btn danger" disabled={busy} onClick={async () => { setBusy(true); try { await service.remove(scope, entry.name); setRemoving(null); await reload() } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)) } finally { if (live.current) setBusy(false) } }}>{t('删除')}</button></div> : <div className="memory-fact-actions"><button className="btn" onClick={() => start(entry)}><Pencil size={13} />{t('编辑')}</button><button className="btn" onClick={() => setRemoving(entry.name)}><Trash2 size={13} />{t('删除')}</button></div>}</div>}
        </section>)}</div>
      </>}
    </>}
  </div>
}
