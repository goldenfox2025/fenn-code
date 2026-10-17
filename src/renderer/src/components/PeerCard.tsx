import { useState } from 'react'
import { routeFor } from '../routes'
import { ChevronRight, CornerDownRight, CornerUpRight, FileText, Link2, PanelRight } from 'lucide-react'
import type { PeerMessage, PeerOutput } from '@shared/model'
import { api, toast, useApp } from '../store'
import { t } from '../i18n'
import { tk } from '@shared/i18n'

/** What a pending message is waiting for, in the sender's words. */
const WAITING: Record<PeerMessage['deliver'], string> = {
  now: tk('正在送达'),
  when_idle: tk('等对方空闲'),
  after_current_task: tk('等对方做完手头的事')
}

function stateLabel(m: PeerMessage): string {
  if (m.state === 'pending') return t(WAITING[m.deliver])
  if (m.state === 'delivered') return t('已送达')
  if (m.state === 'cancelled') return t('已取消')
  return t('没送到')
}

function OutputChip({ o }: { o: PeerOutput }) {
  const set = useApp((s) => s.set)
  const open = async () => {
    if (o.kind === 'page' && o.pageId) return set({ page: { id: o.pageId } })
    if (o.kind === 'link' && o.url) return void window.open(o.url, '_blank')
    if (o.path) {
      const r = await api().openOutput(o.path, false)
      if (!r.ok) toast(r.error ?? t('打不开这个文件'), 'error')
    }
  }
  const Icon = o.kind === 'page' ? PanelRight : o.kind === 'link' ? Link2 : FileText
  return (
    <button className="peer-output" onClick={() => void open()} data-tip={o.url ?? o.path ?? o.title}>
      <Icon size={13} />
      <span className="ellipsis">{o.title}</span>
    </button>
  )
}

/**
 * A message between two threads, as Claude shows a hand-off: on the sender's
 * reply, where it went and whether it arrived (cancellable while waiting); in
 * the receiving thread, who it is from, what it says and what came with it.
 */
export function PeerCard({ peerId, direction }: { peerId: string; direction: 'out' | 'in' }) {
  const m = useApp((s) => s.peerMessages.find((x) => x.id === peerId))
  const other = useApp((s) => s.conversations.find((c) => c.id === (direction === 'out' ? m?.toId : m?.fromId)))
  const navigate = useApp((s) => s.navigate)
  const [open, setOpen] = useState(direction === 'in')
  if (!m) return null
  const name = other?.title ?? t('已删除的讨论串')
  const n = m.outputs?.length ?? 0
  const go = () => other && navigate(routeFor(other))
  return (
    <div className={'peer-card dir-' + direction + ' state-' + m.state}>
      <div className="peer-head">
        {direction === 'out' ? <CornerUpRight size={14} className="muted" /> : <CornerDownRight size={14} className="muted" />}
        <span className="peer-title ellipsis">
          {direction === 'out' ? t('留言给') : t('来自')}
          <button className="peer-link" onClick={go} disabled={!other}>
            「{name}」
          </button>
          {n > 0 && <span className="muted">{t(' · 附 {0} 个产物', n)}</span>}
        </span>
        {direction === 'out' && (
          <span className={'status-chip ' + (m.state === 'pending' ? 'waiting' : m.state === 'delivered' ? 'done' : 'idle')} data-tip={m.reason}>
            {stateLabel(m)}
          </span>
        )}
        {direction === 'out' && m.state === 'pending' && (
          <button className="btn ghost" onClick={() => void api().cancelPeerMessage(m.id)}>
            {t('取消')}
          </button>
        )}
        <button className="icon-btn sm" aria-expanded={open} data-tip={open ? t('收起') : t('展开')} onClick={() => setOpen(!open)}>
          <ChevronRight size={14} className={'chev' + (open ? ' open' : '')} />
        </button>
      </div>
      {open ? (
        <div className="peer-body">
          <div className="peer-text">{m.text}</div>
          {n > 0 && (
            <div className="peer-outputs">
              {m.outputs!.map((o, i) => (
                <OutputChip key={i} o={o} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="peer-preview ellipsis">{m.text}</div>
      )}
    </div>
  )
}
