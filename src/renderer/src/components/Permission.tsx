import { ShieldQuestion } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** While the agent works on, how long an answered request's place is kept for its next one. */
const HOLD_MS = 1500

/**
 * This conversation's permission requests, one at a time, oldest first, with how many more wait.
 * A card rises in; an answered one fades out where it was. Through a run of requests the slot
 * keeps the top of its tallest card, so each next card lands in the same place and the
 * conversation above doesn't move; once no next request comes, the place closes smoothly.
 */
export function PermissionPrompts({ conversationId }: { conversationId: string }) {
  const queue = useApp(useShallow((s) => s.permissions.filter((p) => p.conversationId === conversationId)))
  // The turn goes on (it reads as waiting while a request is open): a next request may follow.
  const working = useApp((s) => ['working', 'waiting'].includes(s.conversations.find((c) => c.id === conversationId)?.status ?? ''))
  const current = queue[0]?.request
  const shown = current?.requestId

  const stack = useRef<HTMLDivElement>(null)
  const last = useRef<PermissionRequest | undefined>(undefined)
  // The tallest card of this run: the slot's height floor, so a shorter next card keeps the same top.
  const [floor, setFloor] = useState(0)
  const [leaving, setLeaving] = useState<PermissionRequest | undefined>(undefined)
  const [closing, setClosing] = useState(false)

  useLayoutEffect(() => {
    if (current) {
      last.current = current
      setLeaving(undefined)
      setClosing(false)
      const el = stack.current
      if (!el) return
      const ro = new ResizeObserver(() => setFloor((f) => Math.max(f, el.offsetHeight)))
      ro.observe(el)
      return () => ro.disconnect()
    }
    if (!last.current) return
    // Answered: the card fades out in its place.
    setLeaving(last.current)
    last.current = undefined
  }, [shown])

  // Its place is kept a while for a next request while the agent works on, then closes.
  const idle = !current && !leaving && floor > 0
  useEffect(() => {
    if (!idle) return
    if (!working) return setClosing(true)
    const close = setTimeout(() => setClosing(true), HOLD_MS)
    return () => clearTimeout(close)
  }, [idle, working])

  if (!current && !leaving && !floor) return null
  return (
    <div
      className={'perm-slot' + (closing ? ' closing' : '')}
      style={{ minHeight: closing ? 0 : floor }}
      // The place has closed (its min-height transition, --dur-2): the next run starts afresh.
      onTransitionEnd={(e) => e.target === e.currentTarget && closing && (setFloor(0), setClosing(false))}
    >
      <div className="perm-stack" ref={stack}>
        {current ? (
          <Prompt key={current.requestId} r={current} more={queue.length - 1} />
        ) : (
          leaving && <Prompt key={leaving.requestId + ':out'} r={leaving} more={0} leaving onGone={() => setLeaving(undefined)} />
        )}
      </div>
    </div>
  )
}

function Prompt({ r, more, leaving, onGone }: { r: PermissionRequest; more: number; leaving?: boolean; onGone?: () => void }) {
  const [tiers, setTiers] = useState<Record<string, Tier>>(() => Object.fromEntries((r.apps ?? []).map((a) => [a.key, a.tier])))
  const allowedAny = Object.values(tiers).some((v) => v !== 'none')
  const answer = (id: string, kind: string) =>
    r.apps && kind.startsWith('allow') ? `${id}:${JSON.stringify(tiers)}` : id
  return (
    <div
      className={'perm' + (leaving ? ' leaving' : '')}
      inert={leaving}
      onAnimationEnd={(e) => leaving && e.target === e.currentTarget && onGone?.()}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 500 }}>
        <ShieldQuestion size={16} style={{ color: 'var(--amber)' }} />
        {t('需要您的许可：')}
        {r.title}
        {/* In the card, so the count going away doesn't change the slot's height. */}
        {more > 0 && <span className="perm-more">{t('还有 {0} 个等您确认', more)}</span>}
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
