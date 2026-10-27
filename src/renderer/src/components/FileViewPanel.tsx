import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, FolderOpen } from 'lucide-react'
import { plainError } from '@shared/errors'
import { api, toast, toastError, useApp } from '../store'
import { t } from '../i18n'
import { useMenu } from './Menu'
import { FileExpansion, type FileViewport } from './files/FileExpansion'
import { PreviewPane } from './PreviewPane'
import { FilePreview, storedView, useEditor, VIEW_KEY, type MdView } from './FilesPane'
import { ReviewFilesPanel } from './reviews/ReviewFilesPanel'
import { PanelState } from './PanelState'

/**
 * A file opened from a chat (an output card, a link in a message), beside it,
 * the way the files panel shows one: in a chat's or project's folder it is
 * typed in and saved by itself; anywhere else it is only shown.
 */
export function FileViewPanel({ path, conversationId, review, exiting }: { path: string; conversationId?: string; review?: { revision: string; expanded?: boolean }; exiting?: boolean }) {
  return review && conversationId ? <ReviewFilesPanel threadId={conversationId} revision={review.revision} path={path} expanded={review.expanded} exiting={exiting} /> : <LocalFileViewPanel path={path} conversationId={conversationId} exiting={exiting} />
}

function LocalFileViewPanel({ path, conversationId, exiting }: { path: string; conversationId?: string; exiting?: boolean }) {
  const [where, setWhere] = useState<{ libraryId?: string; rel?: string } | null>(null)
  useEffect(() => {
    setWhere(null)
    void api().locateFile(path, conversationId).then(setWhere, () => setWhere({}))
  }, [path, conversationId])
  return <PreviewPane exiting={exiting} className="file-view">{where ? <FileView key={path} abs={path} libraryId={where.libraryId} rel={where.rel} /> : <PanelState title={t('正在读取文件…')} />}</PreviewPane>
}

function FileView({ abs, libraryId, rel }: { abs: string; libraryId?: string; rel?: string }) {
  const editor = useEditor(libraryId ?? '', () => {})
  const [view, setView] = useState<MdView>(storedView)
  const [full, setFull] = useState(false)
  const fullOpener = useRef<HTMLElement | null>(null)
  const viewport = useRef<FileViewport>(new Map())
  const [menu, openMenu] = useMenu({ align: 'right' })
  const close = () => void editor.stop().then((ok) => ok && useApp.getState().set({ fileView: null }))
  const name = abs.split(/[\\/]/).pop() ?? abs
  const open = (reveal: boolean) => void api().openOutput(abs, reveal).then((r) => !r.ok && toast(r.error ? plainError(r.error) : t('打不开这个文件'), 'error'), toastError)
  const preview = (inFull: boolean) => (
    <FilePreview
      id={libraryId ?? ''}
      path={rel ?? name}
      root={libraryId ? abs.slice(0, abs.length - (rel ?? '').length).replace(/[\\/]+$/, '') : abs.slice(0, abs.length - name.length).replace(/[\\/]+$/, '')}
      load={libraryId ? undefined : () => api().readLocalFile(abs)}
      draft={editor.draft}
      saveState={editor.state}
      onDraft={editor.change}
      onEdit={() => libraryId && rel && void editor.start(rel)}
      onFlush={() => void editor.flush()}
      onResolve={(keepMine) => void editor.resolve(keepMine)}
      onRecreate={() => void editor.recreate()}
      onDiscard={() => {
        editor.discard()
        useApp.getState().set({ fileView: null })
      }}
      view={view}
      onView={(v) => {
        setView(v)
        try {
          localStorage.setItem(VIEW_KEY, v)
        } catch {
          // Not remembered this time.
        }
      }}
      full={inFull}
      viewport={viewport}
      onFull={(value) => { if (value) fullOpener.current = document.activeElement as HTMLElement; setFull(value) }}
      renaming={false}
      onCommitName={async () => true}
      onCancelName={() => {}}
      onMenu={(el) =>
        openMenu(el, [
          { icon: <ExternalLink size={15} />, label: t('用默认应用打开'), onClick: () => open(false) },
          { icon: <FolderOpen size={15} />, label: t('在文件夹中显示'), onClick: () => open(true) },
          { icon: <Copy size={15} />, label: t('复制路径'), onClick: () => void navigator.clipboard.writeText(abs).then(() => toast(t('已复制路径'))) }
        ])
      }
      onClose={close}
    />
  )
  return (
    <>
      {full ? <div className="files-preview" /> : preview(false)}
      {full && (
        <FileExpansion label={name} opener={fullOpener.current} onCollapse={() => setFull(false)}>{preview(true)}</FileExpansion>
      )}
      {menu}
    </>
  )
}
