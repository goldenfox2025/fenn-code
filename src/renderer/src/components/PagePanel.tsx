import { useEffect, useState } from 'react'
import { Code2, Copy, Download, Eye, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import { api, toast, toastError, useApp } from '../store'
import { t } from '../i18n'
import { Dropdown } from './Menu'
import { ArtifactFrame } from './ArtifactFrame'
import { PreviewPane } from './PreviewPane'

/**
 * A page an agent published, beside the conversation. It runs in a sandboxed
 * iframe served from its own scheme, so its scripts can't touch the app.
 */
export function PagePanel({ id, version }: { id: string; version?: number }) {
  const [info, setInfo] = useState<{ title: string; versions: { version: number; createdAt: number }[] } | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [reload, setReload] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(false)
  const close = () => useApp.getState().set({ page: null })

  useEffect(() => {
    let active = true
    setInfo(null)
    setCode(null)
    setError(false)
    setShowCode(false)
    void api().artifactInfo(id).then((value) => {
      if (!active) return
      setInfo(value)
      setError(!value)
    }, () => { if (active) setError(true) })
    return () => { active = false }
  }, [id, version])
  const current = version ?? info?.versions[info.versions.length - 1]?.version
  useEffect(() => {
    let active = true
    setCode(null)
    if (showCode && current) void api().artifactSource(id, current).then((value) => {
      if (active) setCode(value ?? t('无法加载预览'))
    }, (error) => {
      if (active) {
        setCode(t('无法加载预览'))
        toastError(error)
      }
    })
    return () => { active = false }
  }, [showCode, id, current])

  const download = async () => {
    const html = await api().artifactSource(id, current)
    if (!html) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    a.download = `${info?.title || 'page'}.html`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <PreviewPane expanded={expanded}>
      <div className="panel-head">
        <span className="page-title" title={info?.title}>{info?.title ?? t('页面')}</span>
        {info && info.versions.length > 1 && (
          <Dropdown
            variant="inline"
            value={String(current)}
            onChange={(v) => useApp.getState().set({ page: { id, version: Number(v) } })}
            options={info.versions.map((v) => ({ value: String(v.version), label: t('版本 {0}', v.version) }))}
          />
        )}
        <button className="icon-btn" aria-label={showCode ? t('预览') : t('查看代码')} data-tip={showCode ? t('预览') : t('查看代码')} onClick={() => setShowCode(!showCode)}>
          {showCode ? <Eye size={15} /> : <Code2 size={15} />}
        </button>
        <button className="icon-btn" aria-label={t('重新加载')} data-tip={t('重新加载')} onClick={() => setReload(reload + 1)}>
          <RefreshCw size={15} />
        </button>
        <button
          className="icon-btn"
          aria-label={t('复制代码')}
          data-tip={t('复制代码')}
          onClick={async () => {
            const html = await api().artifactSource(id, current)
            if (html) {
              await navigator.clipboard.writeText(html)
              toast(t('已复制'))
            }
          }}
        >
          <Copy size={15} />
        </button>
        <button className="icon-btn" aria-label={t('下载 HTML')} data-tip={t('下载 HTML')} onClick={download}>
          <Download size={15} />
        </button>
        <button className="icon-btn" aria-label={expanded ? t('还原预览') : t('放大预览')} data-tip={expanded ? t('还原预览') : t('放大预览')} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button className="icon-btn" aria-label={t('关闭')} data-tip={t('关闭')} onClick={close}>
          <X size={16} />
        </button>
      </div>
      {showCode ? (
        <pre className="page-code">{code ?? t('正在加载预览…')}</pre>
      ) : (
        error ? <div className="empty" role="status">{t('无法加载预览')}</div> : current ? (
          <ArtifactFrame
            key={`${id}-${current}-${reload}`}
            id={id}
            version={current}
            title={info?.title ?? 'page'}
          />
        ) : <div className="empty" role="status">{t('正在加载预览…')}</div>
      )}
    </PreviewPane>
  )
}
