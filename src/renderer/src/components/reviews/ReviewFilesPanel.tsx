import { useEffect, useId, useState } from 'react'
import { FileCode2, FolderOpen, LockKeyhole, X } from 'lucide-react'
import type { ReviewFileContent } from '@shared/model'
import { reviewDiffLines } from '@shared/reviewDiff'
import { api, openDeliveryFile, openFileInApp, useApp } from '../../store'
import { errorText } from '@shared/errors'
import { PreviewPane } from '../PreviewPane'
import { t } from '../../i18n'

/** The library's side surface, scoped to immutable delivery files rather than a terminal log. */
export function ReviewFilesPanel({ threadId, revision, path, expanded = false, exiting = false }: { threadId: string; revision: string; path: string; expanded?: boolean; exiting?: boolean }) {
  const thread = useApp((s) => s.conversations.find((c) => c.id === threadId))
  const review = thread?.review?.id === revision ? thread.review : undefined
  const [file, setFile] = useState<ReviewFileContent>()
  const [error, setError] = useState('')
  const [view, setView] = useState<'diff' | 'source'>('diff')
  const viewId = useId()
  useEffect(() => {
    let active = true
    setFile(undefined); setError('')
    void api().deliveryFile(threadId, revision, path).then((f) => { if (active) setFile(f) }, (e) => { if (active) setError(errorText(e)) })
    return () => { active = false }
  }, [threadId, revision, path])
  const close = () => useApp.getState().set({ fileView: null })
  const files = review?.assessment?.files ?? []
  const lines = file ? reviewDiffLines(file.patch) : []
  const source = (file?.after ?? file?.before ?? '').split('\n')
  return <PreviewPane exiting={exiting} className="review-files-panel" layout="thread" expanded={expanded}>
    <div className="panel-head"><FileCode2 size={16} /><span className="review-code-name" data-tip={path}>{path.split('/').at(-1)}</span><span className="review-file-version" data-tip={t('已提交版本（只读）')}><LockKeyhole size={12} /><code>{review?.head?.slice(0, 8)}</code></span>{thread?.workspace && <button className="icon-btn" aria-label={t('打开工作区文件')} data-tip={t('打开工作区文件')} onClick={() => openFileInApp(`${thread.workspace!.path}/${path}`, threadId)}><FolderOpen size={15} /></button>}<button className="icon-btn" aria-label={t('关闭更改文件')} onClick={close}><X size={16} /></button></div>
    {files.length > 1 && <nav className="review-files-nav" aria-label={t('本次更改的文件')}>
      {files.map((name) => <button key={name} className={'review-file-row' + (name === path ? ' selected' : '')} aria-pressed={name === path} onClick={() => openDeliveryFile(threadId, revision, name, expanded)}><FileCode2 size={14} /><span>{name}</span></button>)}
    </nav>}
    <div className="review-code-toolbar"><div className="tabs" role="tablist" aria-label={t('文件视图')} onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      e.preventDefault()
      const next = e.key === 'Home' ? 'diff' : e.key === 'End' ? 'source' : view === 'diff' ? 'source' : 'diff'
      setView(next)
      document.getElementById(`${viewId}-${next}`)?.focus({ preventScroll: true })
    }}>
      <button id={`${viewId}-diff`} className={'tab' + (view === 'diff' ? ' active' : '')} role="tab" aria-selected={view === 'diff'} aria-controls={`${viewId}-content`} tabIndex={view === 'diff' ? 0 : -1} onClick={() => setView('diff')}>{t('更改')}</button>
      <button id={`${viewId}-source`} className={'tab' + (view === 'source' ? ' active' : '')} role="tab" aria-selected={view === 'source'} aria-controls={`${viewId}-content`} tabIndex={view === 'source' ? 0 : -1} onClick={() => setView('source')}>{t('源文件')}</button>
    </div></div>
    <div className="review-code-scroll" id={`${viewId}-content`} role="tabpanel" aria-labelledby={`${viewId}-${view}`} tabIndex={0} aria-busy={!file && !error}>
      {!review ? <div className="panel-empty-state">{t('交付版本已变化，请重新查看最新提交。')}</div> : error ? <div className="panel-empty-state" role="alert">{error}</div> : !file ? <div className="panel-empty-state">{t('正在读取文件…')}</div> : file.binary || file.tooBig ? <div className="panel-empty-state">{file.binary ? t('二进制文件，无法显示文本差异。') : t('文件较大，请在工作区查看。')}</div> :
        <div className={'review-code ' + view} aria-label={view === 'diff' ? t('文件差异') : t('源文件')}>
          {view === 'diff' ? lines.map((line, i) => <div key={i} className={'review-code-line ' + line.kind}>
            {line.kind === 'hunk' ? <span className="review-code-hunk">{t('第 {0} 行附近', line.newLine ?? line.oldLine ?? 0)}{line.text ? ` · ${line.text}` : ''}</span> : <><span className="review-code-number">{line.oldLine ?? ''}</span><span className="review-code-number">{line.newLine ?? ''}</span><span className="review-code-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}</span><code>{line.text || ' '}</code></>}
          </div>) : source.map((text, i) => <div className="review-code-line context" key={i}><span className="review-code-number">{i + 1}</span><code>{text || ' '}</code></div>)}
          {view === 'diff' && !lines.length && <div className="panel-empty-state">{t('此文件没有可显示的文本差异。')}</div>}
        </div>}
    </div>
  </PreviewPane>
}
