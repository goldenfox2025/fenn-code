import { ShieldQuestion } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PermissionRequest } from '../../../shared/contract'
import { api, useApp } from '../store'
import { t } from '../i18n'

type Tier = 'full' | 'click' | 'view' | 'none'
const TIERS: { id: Tier; label: string }[] = [
  { id: 'full', label: '完全控制' }, // i18n-ignore: translated where shown
  { id: 'click', label: '仅点击' }, // i18n-ignore
  { id: 'view', label: '仅查看' }, // i18n-ignore
  { id: 'none', label: '不允许' } // i18n-ignore
]

/** How long an answered request's place is kept for the next one (agents often ask several in a row). */
const HOLD_MS = 400

/**
 * This conversation's permission requests, one at a time, oldest first, with how many more wait.
 * After an answer the card's place is held a moment, so a next request lands where it was
 * and the conversation above doesn't jump.
 */
export function PermissionPrompts({ conversationId }: { conversationId: string }) {
  const queue = useApp(useShallow((s) => s.permissions.filter((p) => p.conversationId === conversationId)))
  const current = queue[0]

  const box = useRef<HTMLDivElement>(null)
  const height = useRef(0)
  const [hold, setHold] = useState<{ height: number; closing?: boolean } | null>(null)
  const shown = current?.request.requestId
  useLayoutEffect(() => {
    const el = box.current
    if (shown && el) {
      setHold(null)
      // Its height as last drawn: that is the place to keep once it goes.
      const ro = new ResizeObserver(() => (height.current = el.offsetHeight))
      ro.observe(el)
      return () => ro.disconnect()
    }
    if (!height.current) return
    setHold({ height: height.current })
    height.current = 0
    const close = setTimeout(() => setHold({ height: 0, closing: true }), HOLD_MS)
    return () => clearTimeout(close)
  }, [shown])

  // The held place closes with its CSS transition (--dur-2) and goes once that has run.
  if (!current)
    return hold ? (
      <div
        className={'perm-hold' + (hold.closing ? ' closing' : '')}
        style={{ height: hold.height }}
        onTransitionEnd={() => hold.closing && setHold(null)}
      />
    ) : null
  return (
    <div className="perm-slot" ref={box}>
      <Prompt key={current.request.requestId} r={current.request} />
      {queue.length > 1 && <div className="perm-more">{t('还有 {0} 个等您确认', queue.length - 1)}</div>}
    </div>
  )
}

function Prompt({ r }: { r: PermissionRequest }) {
  const [tiers, setTiers] = useState<Record<string, Tier>>(() => Object.fromEntries((r.apps ?? []).map((a) => [a.key, a.tier])))
  const allowedAny = Object.values(tiers).some((v) => v !== 'none')
  const answer = (id: string, kind: string) =>
    r.apps && kind.startsWith('allow') ? `${id}:${JSON.stringify(tiers)}` : id
  return (
    <div className="perm">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
        <ShieldQuestion size={16} style={{ color: 'var(--amber)' }} />
        {t('需要您的许可：')}
        {r.title}
      </div>
      {r.detail && <div className={'detail' + (r.apps ? ' prose' : '')}>{r.detail}</div>}
      {r.apps && (
        <div className="perm-apps">
          {r.apps.map((a) => (
            <div key={a.key} className="perm-app">
              <span className="name">
                {a.name}
                {!a.running && <span className="muted">{t('（未运行）')}</span>}
              </span>
              <div className="seg-control sm">
                {TIERS.map((o) => (
                  <button key={o.id} className={tiers[a.key] === o.id ? 'on' : ''} onClick={() => setTiers({ ...tiers, [a.key]: o.id })}>
                    {t(o.label)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="help">{t('完全控制：可以点击和输入。仅点击：不能输入文字或按键，适合终端和代码编辑器。仅查看：只能截图。')}</div>
        </div>
      )}
      <div className="actions">
        {r.options.map((o) => {
          const allow = o === r.options.find((x) => x.kind.startsWith('allow'))
          return (
            <button
              key={o.id}
              className={'btn' + (allow ? ' primary' : '')}
              disabled={allow && !!r.apps && !allowedAny}
              onClick={() => api().respondPermission(r.requestId, answer(o.id, o.kind))}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
