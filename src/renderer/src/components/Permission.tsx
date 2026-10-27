import { ShieldQuestion } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PermissionRequest } from '../../../shared/contract'
import { api, toastError, useApp } from '../store'
import { t } from '../i18n'
import { SegmentedControl } from './SegmentedControl'

type Tier = 'full' | 'click' | 'view' | 'none'
const TIERS: { id: Tier; label: string }[] = [
  { id: 'full', label: '完全控制' }, // i18n-ignore: translated where shown
  { id: 'click', label: '仅点击' }, // i18n-ignore
  { id: 'view', label: '仅查看' }, // i18n-ignore
  { id: 'none', label: '不允许' } // i18n-ignore
]

/** Approval is an overlay above the composer, never part of transcript sizing. */
export function PermissionPrompts({ conversationId }: { conversationId: string }) {
  const queue = useApp(useShallow((s) => s.permissions.filter((p) => p.conversationId === conversationId)))
  const current = queue[0]?.request
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = slot.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const place = () => el.style.setProperty('--perm-space', `${Math.max(80, el.getBoundingClientRect().top - parent.getBoundingClientRect().top - 64)}px`)
    const observer = new ResizeObserver(place)
    observer.observe(parent)
    if (el.nextElementSibling) observer.observe(el.nextElementSibling)
    window.addEventListener('resize', place)
    place()
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [current?.requestId])
  if (!current) return null
  return (
    <div className="perm-slot" ref={slot}>
      <div className="perm-stack">
        <Prompt key={current.requestId} r={current} more={queue.length - 1} />
      </div>
    </div>
  )
}

function Prompt({ r, more }: { r: PermissionRequest; more: number }) {
  const [tiers, setTiers] = useState<Record<string, Tier>>(() => Object.fromEntries((r.apps ?? []).map((a) => [a.key, a.tier])))
  const [answering, setAnswering] = useState(false)
  const allowedAny = Object.values(tiers).some((v) => v !== 'none')
  const answer = (id: string, kind: string) =>
    r.apps && kind.startsWith('allow') ? `${id}:${JSON.stringify(tiers)}` : id
  return (
    <div className="perm" role="group" aria-label={t('需要您的许可：')}>
      <div className="perm-heading" role="alert" aria-atomic="true">
        <ShieldQuestion size={16} style={{ color: 'var(--amber)' }} />
        {t('需要您的许可：')}
        <span className="perm-title" tabIndex={0}>{r.title}</span>
        {more > 0 && <span className="perm-more">{t('还有 {0} 个等您确认', more)}</span>}
      </div>
      <div className="perm-body" tabIndex={0}>
        {r.detail && <div className={'detail' + (r.apps ? ' prose' : '')}>{r.detail}</div>}
        {r.apps && (
          <div className="perm-apps">
            {r.apps.map((a) => (
              <div key={a.key} className="perm-app">
                <span className="name">
                  {a.name}
                  {!a.running && <span className="muted">{t('（未运行）')}</span>}
                </span>
                <SegmentedControl className="sm" label={a.name} value={tiers[a.key]} onChange={(tier) => setTiers({ ...tiers, [a.key]: tier })} options={TIERS.map((o) => ({ value: o.id, label: t(o.label) }))} />
              </div>
            ))}
            <div className="help">{t('完全控制：可以点击和输入。仅点击：不能输入文字或按键，适合终端和代码编辑器。仅查看：只能截图。')}</div>
          </div>
        )}
      </div>
      <div className="actions">
        {r.options.map((o) => {
          const allow = o === r.options.find((x) => x.kind.startsWith('allow'))
          return (
            <button
              key={o.id}
              className={'btn' + (allow ? ' primary' : '')}
              disabled={answering || (allow && !!r.apps && !allowedAny)}
              onClick={async () => {
                setAnswering(true)
                try { await api().respondPermission(r.requestId, answer(o.id, o.kind)) }
                catch (error) { setAnswering(false); toastError(error) }
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
