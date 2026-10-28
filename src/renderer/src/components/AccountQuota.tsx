import { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import type { CreditQuota } from '@shared/contract'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { useMenu } from './Menu'
import { creditsMenu } from './Usage'

/** Account scope belongs to the app chrome, independently of any session's context. */
export function AccountQuota() {
  const backendId = useApp(s => {
    const route = s.route
    const id = route.view === 'chat' ? route.conversationId : route.view === 'project'
      ? route.threadId ?? s.projects.find(p => p.id === route.projectId)?.conversationId : undefined
    const conversation = s.conversations.find(c => c.id === id)
    return conversation?.nextBackendId ?? conversation?.backendId ?? s.settings.defaultBackendId
  })
  const backend = useApp(s => s.backends.find(b => b.id === backendId))
  return backend?.credits ? <BackendQuota key={backend.id} backendId={backend.id} name={backend.name} /> : null
}

function BackendQuota({ backendId, name }: { backendId: string; name: string }) {
  // A completed turn in any session can change this account's quota.
  const activity = useApp(s => s.conversations.reduce((sum, c) => c.backendId === backendId
    ? sum + (c.usage?.turns ?? 0) + (c.usage?.unreported ?? 0) : sum, 0))
  const [quota, setQuota] = useState<CreditQuota>()
  const [loading, setLoading] = useState(true)
  const [menu, openMenu, update] = useMenu({ align: 'right', placement: 'below', compact: true })
  useEffect(() => {
    let live = true
    const read = () => {
      setLoading(true)
      void api().backendCredits(backendId).then(
        value => { if (live) setQuota(value) },
        () => { if (live) setQuota(undefined) }
      ).finally(() => { if (live) setLoading(false) })
    }
    read()
    const timer = setInterval(read, 60000)
    return () => { live = false; clearInterval(timer) }
  }, [backendId, activity])
  useEffect(() => update(creditsMenu(quota, name, loading)), [quota, loading, name])

  if (!quota?.buckets.length) return null
  const bucket = quota.buckets.find(b => b.used !== undefined && b.total !== undefined && b.total > 0)
  const percentage = bucket ? Math.max(0, Math.min(100, bucket.used! / bucket.total! * 100)) : undefined
  const value = percentage === undefined ? undefined : percentage > 0 && percentage < 1 ? '<1%' : `${Math.round(percentage)}%`
  return <>
    <button className="account-quota pill-btn" aria-label={t('{0} 账户额度', name)} aria-haspopup="menu"
      data-tip={t('{0} 账户额度', name)} onClick={event => openMenu(event.currentTarget, creditsMenu(quota, name, loading))}>
      <Gauge size={15} aria-hidden="true" />
      <span className="account-quota-name">{name}</span>
      {value && <span className="account-quota-value">{value}</span>}
    </button>
    {menu}
  </>
}
