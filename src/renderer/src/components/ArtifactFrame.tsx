import { useState } from 'react'
import { t } from '../i18n'
import { WorkingMark } from './WorkingMark'

/** Same isolated renderer in a reply and the larger preview pane. */
export function ArtifactFrame({ id, version, title, inline = false }: { id: string; version: number; title: string; inline?: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [since] = useState(Date.now)
  return (
    <div className={'artifact-surface' + (inline ? ' inline' : '')}>
      {failed ? <div className="artifact-loading" role="status">{t('无法加载预览')}</div> : !loaded && <div className="artifact-loading"><WorkingMark since={since} label={t('正在加载预览…')} /></div>}
      <iframe
        className="page-frame"
        title={title}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        src={`oc-page://page/${id}/${version}`}
        loading={inline ? 'lazy' : 'eager'}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </div>
  )
}
