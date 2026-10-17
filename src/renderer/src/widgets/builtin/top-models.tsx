import { formatTokens } from '@shared/usage'
import { useApp } from '../../store'
import { t } from '../../i18n'
import type { Widget } from '../registry'
import { WidgetCard } from '../WidgetCard'
import { useUsageSummary } from '../usage'

/** Models listed by name; the rest are summed into one line. */
const TOP_MODELS = 4

/** The most used models by tokens, each with its share as a bar; the rest summed into one line. */
function TopModels() {
  const models = useUsageSummary()?.models ?? []
  const backends = useApp((s) => s.backends)
  const catalogs = useApp((s) => s.settings.backendModels)
  if (!models.length) return null
  const total = models.reduce((n, m) => n + m.tokens, 0)
  const backendName = (id: string) => backends.find((b) => b.id === id)?.name ?? id
  const rows = models.slice(0, TOP_MODELS).map((m) => {
    const name = m.name ?? catalogs?.[m.backendId]?.models.find((x) => x.id === m.id)?.name ?? m.id
    return { key: `${m.backendId}/${m.id ?? ''}`, name: name ?? backendName(m.backendId), via: name ? backendName(m.backendId) : undefined, tokens: m.tokens, replies: m.replies }
  })
  const rest = models.slice(TOP_MODELS)
  if (rest.length)
    rows.push({ key: 'rest', name: t('其他 {0} 个', rest.length), via: undefined, tokens: rest.reduce((n, m) => n + m.tokens, 0), replies: rest.reduce((n, m) => n + m.replies, 0) })
  const share = (n: number) => (total ? n / total : 0)
  return (
    <WidgetCard title={t('常用模型')}>
      {rows.map((r) => (
        <div key={r.key} className="top-model" data-tip={t('{0} tokens · {1} 条回复', formatTokens(r.tokens), r.replies)}>
          <span className="top-model-name">
            {r.name}
            {r.via && <span className="top-model-via">{r.via}</span>}
          </span>
          <span className="top-model-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(2, share(r.tokens) * 100)}%` }} />
          </span>
          <span className="top-model-share">{percent(share(r.tokens))}</span>
        </div>
      ))}
    </WidgetCard>
  )
}

/** A share as a whole percentage; a sliver reads <1%, not 0%. */
const percent = (x: number) => (x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`)

export default { id: 'top-models', title: t('常用模型'), size: 'half', order: 30, Component: TopModels } satisfies Widget
