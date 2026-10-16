import { ExternalLink, FileText, FolderOpen, Link2 } from 'lucide-react'
import type { Project, ProjectOutput } from '@shared/model'
import { api, toast, useApp } from '../store'
import { t } from '../i18n'

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

type Output = Pick<ProjectOutput, 'kind' | 'title' | 'path' | 'url' | 'size'>

async function openFile(path: string, reveal = false) {
  const r = await api().openOutput(path, reveal)
  if (!r.ok) toast(r.error ?? t('打不开这个文件'), 'error')
}

/** A file or link the agent handed over, under its reply (like Claude's output cards). */
export function OutputCard({ o }: { o: Output }) {
  const isLink = o.kind === 'link'
  const open = () => (isLink ? window.open(o.url, '_blank') : o.path && void openFile(o.path))
  const where = isLink ? o.url?.replace(/^https?:\/\//, '').split('/')[0] : o.path
  return (
    <div className="output-card">
      <button className="output-main" onClick={open} title={isLink ? o.url : o.path}>
        <span className="page-card-icon">{isLink ? <Link2 size={18} /> : <FileText size={18} />}</span>
        <span className="page-card-text">
          <span className="t">{o.title}</span>
          <span className="small muted ellipsis">
            {isLink ? where : [o.size !== undefined ? humanSize(o.size) : '', where].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {isLink ? (
        <button className="icon-btn sm" title={t('在浏览器中打开')} onClick={open}>
          <ExternalLink size={15} />
        </button>
      ) : (
        <button className="icon-btn sm" title={t('在文件夹中显示')} onClick={() => o.path && void openFile(o.path, true)}>
          <FolderOpen size={15} />
        </button>
      )}
    </div>
  )
}

/** The project's library: everything agents handed over, newest first, with where it came from. */
export function OutputsPanel({ project }: { project: Project }) {
  const conversations = useApp((s) => s.conversations)
  const navigate = useApp((s) => s.navigate)
  const list = [...(project.outputs ?? [])].reverse()
  if (!list.length)
    return <div className="empty">{t('agent 交付的文件和链接会出现在这里。')}</div>
  return (
    <div className="outputs-panel">
      {list.map((o) => {
        const conv = conversations.find((c) => c.id === o.conversationId)
        return (
          <div key={o.id} className="output-row">
            <OutputCard o={o} />
            {conv && (
              <button className="text-link small" onClick={() => navigate(conv.kind === 'thread' ? { view: 'project', projectId: project.id, threadId: conv.id } : conv.kind === 'chat' ? { view: 'chat', conversationId: conv.id } : { view: 'project', projectId: project.id })}>
                {t('来自「{0}」', conv.title)}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
