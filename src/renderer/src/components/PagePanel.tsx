import { useEffect, useState } from 'react'
import { Code2, Copy, Download, Eye, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import { api, toast, toastError, useApp } from '../store'
import { t } from '../i18n'
import { Dropdown } from './Menu'
import { ArtifactFrame } from './ArtifactFrame'
import { PreviewPane } from './PreviewPane'
import { PanelState } from './PanelState'

/**
 * A page an agent published, beside the conversation. It runs in a sandboxed
 * iframe served from its own scheme, so its scripts can't touch the app.
 */
type Page = { id: string; version?: number }
const pageKey = (page: Page) => `${page.id}:${page.version ?? 'latest'}`

/** Keep only the three most recently opened previews alive in this window. */
export function PagePanels({ selected: page, exiting = false }: { selected: Page | null; exiting?: boolean }) {
  const [recent, setRecent] = useState<Page[]>([])
  const key = page && pageKey(page)
  const newest = recent.at(-1)
  if (page && (!newest || pageKey(newest) !== key)) {
    setRecent([...recent.filter((p) => pageKey(p) !== key), page].slice(-3))
  }
  // Updating recency must not move mounted iframe nodes: DOM reparenting can
  // navigate a frame even when React kept its key. Hidden panes keep fixed order.
  return [...recent].sort((a, b) => pageKey(a).localeCompare(pageKey(b))).map((p) => (
    <PagePanel key={pageKey(p)} {...p} active={pageKey(p) === key} exiting={exiting} />
  ))
}

function PagePanel({ id, version, active, exiting }: Page & { active: boolean; exiting: boolean }) {
  const [info, setInfo] = useState<{ title: string; versions: { version: number; createdAt: number }[] } | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [reload, setReload] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(false)
  const close = () => useApp.getState().set({ page: null })

  useEffect(() => {
    if (!active) return
    let live = true
    setError(false)
    void api().artifactInfo(id).then((value) => {
      if (!live) return
      setInfo(value)
      setError(!value)
    }, () => { if (live) setError(true) })
    return () => { live = false }
  }, [id, version, active])
  const current = version ?? info?.versions[info.versions.length - 1]?.version
  useEffect(() => {
    setCode(null)
  }, [id, current])
  useEffect(() => {
    let active = true
    if (showCode && current && code === null) void api().artifactSource(id, current).then((value) => {
      if (active) setCode(value ?? t('无法加载预览'))
    }, (error) => {
      if (active) {
        setCode(t('无法加载预览'))
        toastError(error)
      }
    })
    return () => { active = false }
  }, [showCode, id, current, code])

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
    <PreviewPane expanded={expanded} hidden={!active} exiting={exiting && active}>
      <div className="panel-head">
        <span className="page-title" data-tip={info?.title}>{info?.title ?? t('页面')}</span>
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
      {showCode && <pre className="page-code">{code ?? t('正在加载预览…')}</pre>}
      {error ? <PanelState title={t('无法加载预览')} /> : current ? (
        <ArtifactFrame
          key={`${id}-${current}-${reload}`}
          id={id}
          version={current}
          title={info?.title ?? 'page'}
          active={active && !showCode}
          reload={reload}
        />
      ) : !showCode && <PanelState title={t('正在加载预览…')} />}
    </PreviewPane>
  )
}
