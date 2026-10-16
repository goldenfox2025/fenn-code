import { useEffect, useState } from 'react'
import { Code2, Copy, Download, Eye, RefreshCw, X } from 'lucide-react'
import { api, toast, useApp } from '../store'
import { t } from '../i18n'
import { Dropdown } from './Menu'

/**
 * A page an agent published, beside the conversation. It runs in a sandboxed
 * iframe served from its own scheme, so its scripts can't touch the app.
 */
export function PagePanel({ id, version }: { id: string; version?: number }) {
  const [info, setInfo] = useState<{ title: string; versions: { version: number; createdAt: number }[] } | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [reload, setReload] = useState(0)
  const close = () => useApp.getState().set({ page: null })

  useEffect(() => {
    void api().artifactInfo(id).then(setInfo)
    setShowCode(false)
  }, [id, version])
  const current = version ?? info?.versions[info.versions.length - 1]?.version
  useEffect(() => {
    if (showCode && current) void api().artifactSource(id, current).then(setCode)
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
    <aside className="page-panel">
      <div className="panel-head">
        <span className="page-title">{info?.title ?? t('页面')}</span>
        {info && info.versions.length > 1 && (
          <Dropdown
            variant="inline"
            value={String(current)}
            onChange={(v) => useApp.getState().set({ page: { id, version: Number(v) } })}
            options={info.versions.map((v) => ({ value: String(v.version), label: t('版本 {0}', v.version) }))}
          />
        )}
        <span className="spacer" />
        <button className="icon-btn" data-tip={showCode ? t('预览') : t('查看代码')} onClick={() => setShowCode(!showCode)}>
          {showCode ? <Eye size={15} /> : <Code2 size={15} />}
        </button>
        <button className="icon-btn" data-tip={t('重新加载')} onClick={() => setReload(reload + 1)}>
          <RefreshCw size={15} />
        </button>
        <button
          className="icon-btn"
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
        <button className="icon-btn" data-tip={t('下载 HTML')} onClick={download}>
          <Download size={15} />
        </button>
        <button className="icon-btn" data-tip={t('关闭')} onClick={close}>
          <X size={16} />
        </button>
      </div>
      {showCode ? (
        <pre className="page-code">{code}</pre>
      ) : (
        current && (
          <iframe
            key={`${id}-${current}-${reload}`}
            className="page-frame"
            title={info?.title ?? 'page'}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            src={`oc-page://page/${id}/${current}`}
          />
        )
      )}
    </aside>
  )
}
