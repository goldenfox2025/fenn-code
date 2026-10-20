import { Maximize2 } from 'lucide-react'
import { t } from '../i18n'
import { useApp } from '../store'
import { ArtifactFrame } from './ArtifactFrame'

/** A live visualization stays with the answer; the side pane is an explicit expansion. */
export function InteractivePreview({ id, title, version }: { id: string; title: string; version: number }) {
  return (
    <section className="interactive-preview" aria-label={title}>
      <ArtifactFrame key={`${id}-${version}`} id={id} version={version} title={title} inline />
      <div className="interactive-actions">
        {version > 1 && <span className="interactive-version">{t('版本 {0}', version)}</span>}
        <button className="icon-btn" aria-label={t('在侧栏展开')} data-tip={t('在侧栏展开')} onClick={() => useApp.getState().set({ page: { id, version }, fileView: null })}>
          <Maximize2 size={14} />
        </button>
      </div>
    </section>
  )
}
