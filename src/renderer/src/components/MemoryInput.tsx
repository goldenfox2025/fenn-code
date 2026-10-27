import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, AtSign, FileText, Paperclip, X } from 'lucide-react'
import type { MemoryEntry } from '@shared/model'
import type { MemoryDraft, MemoryInput as Input, MemorySkill } from '@shared/memoryInput'
import type { MemoryService } from './MemoryManager'

interface Draft extends Input { original?: MemoryEntry; result?: MemoryDraft; pending?: Promise<MemoryDraft> }
const drafts = new WeakMap<MemoryService, Map<string, Draft>>()
export const pendingMemoryDraft = (service: MemoryService, scope: string) => drafts.get(service)?.get(scope)
export function clearMemoryDraft(service: MemoryService, scope: string) { drafts.get(service)?.delete(scope) }

/** A single intention field; names, summaries and type are the selected backend's job. */
export function MemoryInput({ scope, original, service, translate: t, onCancel, onSaved }: {
  scope: string; original?: MemoryEntry; service: MemoryService; translate: (text: string) => string; onCancel: () => void; onSaved: (name: string) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => pendingMemoryDraft(service, scope) || { original, text: original?.body || '', files: [], skills: [], result: original && { name: original.name, description: original.description, type: original.type as MemoryDraft['type'], body: original.body } })
  const [skills, setSkills] = useState<MemorySkill[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(!!draft.pending), [discard, setDiscard] = useState(false), [active, setActive] = useState(0), [dismissed, setDismissed] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null), live = useRef(true)
  useEffect(() => { live.current = true; let current = true; void service.skills(scope).then(items => { if (current) setSkills(items) }).catch(() => {}); return () => { current = false; live.current = false } }, [scope, service])
  const change = (next: Draft) => { if (live.current) { setDraft(next); setError('') } if (!drafts.has(service)) drafts.set(service, new Map()); drafts.get(service)!.set(scope, next) }
  useEffect(() => {
    if (!draft.pending) return
    let mounted = true
    const pending = draft.pending
    void pending.then(result => { if (mounted) change({ ...draft, pending: undefined, text: result.body, result }) }, cause => { if (mounted) { change({ ...draft, pending: undefined }); setError(cause instanceof Error ? cause.message : String(cause)) } }).finally(() => { if (mounted) setBusy(false) })
    return () => { mounted = false }
  }, [draft.pending])
  const match = /(?:^|\s)@([^@\s]*)$/.exec(draft.text), query = !dismissed && match ? match[1].toLowerCase() : null
  const choices = query !== null ? skills.filter(skill => !draft.skills?.includes(skill.id) && `${skill.name} ${skill.description}`.toLowerCase().includes(query)).slice(0, 20) : []
  const choose = (skill: MemorySkill) => { change({ ...draft, text: draft.text.replace(/@[^@\s]*$/, `@${skill.name} `), skills: [...(draft.skills || []), skill.id] }); setDismissed(true); textarea.current?.focus({ preventScroll: true }) }
  const attach = async (files: FileList | File[]) => {
    try {
      if ((draft.files?.length || 0) + files.length > 8) throw Error(t('最多添加 8 个文件。'))
      const added = await Promise.all(Array.from(files).map(async file => {
        if (file.size > 48000 || (!/\.(md|txt|json|yaml|yml|csv|log|html|css|ts|js|py)$/i.test(file.name) && !file.type.startsWith('text/'))) throw Error(t('请选择不超过 48 KB 的文本或 Markdown 文件。'))
        return { name: file.name, text: await file.text() }
      }))
      change({ ...draft, files: [...(draft.files || []), ...added] })
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const cancel = () => {
    if (draft.text !== (original?.body || '') || draft.files?.length || draft.skills?.length) { setDiscard(true); return }
    clearMemoryDraft(service, scope); onCancel()
  }
  return <form className="memory-input-form" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault(); event.stopPropagation()
    if (busy) return
    if (discard) { setDiscard(false); textarea.current?.focus({preventScroll:true}) }
    else cancel()
  }} onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    try {
      if (!draft.result) {
        const pending = service.compose(scope, draft)
        change({ ...draft, pending })
        const result = await pending
        change({ ...draft, pending: undefined, text: result.body, result })
        return
      }
      const result = { ...draft.result, body: draft.text }, existing = await service.list(scope)
      const slug = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 56)
      const base = slug(result.name) || 'memory'; let name = original?.name || base, suffix = 2
      while (!original && existing.some(entry => entry.name === name)) name = `${base}-${suffix++}`
      await service.save(scope, { ...result, name }); clearMemoryDraft(service, scope)
      if (live.current) onSaved(name)
    } catch (cause) { change({ ...draft, pending: undefined }); if (live.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (live.current) setBusy(false) }
  }}>
    <button type="button" className="memory-back" onClick={cancel} disabled={busy}><ArrowLeft size={14} />{t('返回记忆')}</button>
    <label className="memory-intention-label" htmlFor={`memory-input-${scope}`}>{draft.result ? draft.result.description : t('希望记住什么？')}</label>
    {draft.result && !original && <p className="memory-draft-note" role="status">{t('已整理，确认内容后保存。')}</p>}
    <div className="memory-intention" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy && !draft.result) void attach(event.dataTransfer.files) }}>
      <textarea autoFocus ref={textarea} id={`memory-input-${scope}`} aria-label={t('记忆内容')} className="textarea" value={draft.text} disabled={busy} placeholder={t('用自己的话描述，也可以添加文件或 @ 引用 skill…')} rows={7}
        onChange={event => { change({ ...draft, text: event.target.value }); setDismissed(false); setActive(0) }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (!choices.length) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length) }
          else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); choose(choices[active] || choices[0]) }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true) }
        }} />
      {choices.length > 0 && <div className="memory-skill-list" role="listbox" aria-label={t('引用已安装的 skill')}>{choices.map((skill, index) => <button type="button" key={skill.id} role="option" aria-selected={active === index} onMouseDown={event => event.preventDefault()} onClick={() => choose(skill)}><AtSign size={14} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></button>)}</div>}
      {!draft.result && <div className="memory-input-tools"><button type="button" className="icon-btn" aria-label={t('添加参考文件')} data-tip={t('添加参考文件')} disabled={busy} onClick={() => picker.current?.click()}><Paperclip size={16} /></button><button type="button" className="icon-btn" aria-label={t('引用 skill')} data-tip={t('引用 skill')} disabled={busy} onClick={() => { change({ ...draft, text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? ' ' : ''}@` }); setDismissed(false); textarea.current?.focus() }}><AtSign size={16} /></button><small>{t('由当前后端整理')}</small></div>}
      <input ref={picker} hidden type="file" multiple accept=".md,.txt,.json,.yaml,.yml,.csv,.log,.html,.css,.ts,.js,.py" onChange={event => { if (event.target.files) void attach(event.target.files); event.target.value = '' }} />
    </div>
    {!!(draft.files?.length || draft.skills?.length) && <div className="memory-reference-chips">{draft.files?.map((file, index) => <span key={`${index}-${file.name}`}><FileText size={13} />{file.name}<button type="button" aria-label={`${t('移除')} ${file.name}`} disabled={busy} onClick={() => change({ ...draft, files: draft.files!.filter((_, i) => i !== index) })}><X size={12} /></button></span>)}{draft.skills?.map(id => <span key={id}><AtSign size={13} />{skills.find(skill => skill.id === id)?.name || t('skill')}<button type="button" aria-label={t('移除 skill')} disabled={busy} onClick={() => change({ ...draft, skills: draft.skills!.filter(skill => skill !== id) })}><X size={12} /></button></span>)}</div>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    {discard ? <div className="memory-delete" role="alert"><span>{t('放弃尚未保存的修改？')}</span><button type="button" className="btn" onClick={() => setDiscard(false)}>{t('继续编辑')}</button><button type="button" className="btn danger" onClick={() => { clearMemoryDraft(service, scope); onCancel() }}>{t('放弃更改')}</button></div>
      : <div className="memory-form-actions"><button type="button" className="btn" onClick={cancel} disabled={busy}>{t('取消')}</button><button type="submit" className="btn primary" disabled={busy || (!draft.text.trim() && !draft.files?.length && !draft.skills?.length)}>{busy ? draft.result ? t('正在保存…') : t('正在整理…') : draft.result ? t('保存记忆') : t('整理记忆')}</button></div>}
  </form>
}
