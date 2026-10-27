import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type CSSProperties } from 'react'
import { Bookmark } from 'lucide-react'
import { t } from '@shared/i18n'
import { conversationIndexRows, conversationNodeTone, conversationNodeWeight, visibleConversationIds } from '@shared/conversationIndex'

export interface ConversationNode { id: string; prompt: string; reply?: string }
export function ConversationNodes({ scope, scroller, entries, onNavigate }: { scope: string; scroller: RefObject<HTMLDivElement | null>; entries: ConversationNode[]; onNavigate: () => void }) {
  const [points, setPoints] = useState<{ id: string; offset: number }[]>([]), [active, setActive] = useState(''), [preview, setPreview] = useState<string | null>(null)
  const [saved, setSaved] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(`nodes:${scope}`) || '[]') } catch { return [] } })
  const onMove = useRef(onNavigate); onMove.current = onNavigate
  const nav = useRef<HTMLElement>(null), previewBox = useRef<HTMLDivElement>(null)
  const [railHeight, setRailHeight] = useState(600)
  const [visible, setVisible] = useState<string[]>([])
  const signature = entries.map(entry => entry.id).join('|')
  useEffect(() => {
    try { setSaved(JSON.parse(localStorage.getItem(`nodes:${scope}`) || '[]')) } catch { setSaved([]) }
    setPreview(null)
  }, [scope])
  useEffect(() => {
    const root = scroller.current; if (!root) return
    let frame = 0, current: typeof points = []
    const update = () => {
      frame = 0
      const box = root.getBoundingClientRect()
      nav.current?.style.setProperty('--node-preview-room', `${root.clientWidth}px`)
      setRailHeight(Math.max(18, root.clientHeight - 20))
      current = entries.flatMap(entry => { const element = root.querySelector<HTMLElement>(`[data-mid="${CSS.escape(entry.id)}"]`); if (!element) return []; const offset = element.getBoundingClientRect().top - box.top + root.scrollTop; return [{ id: entry.id, offset }] })
      setPoints(current); scroll()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const scroll = () => { const selected = current.findLast(point => point.offset <= root.scrollTop + root.clientHeight * .4) || current[0]; if (selected) setActive(selected.id); const ids = visibleConversationIds(current, root.scrollTop, root.clientHeight, root.scrollHeight); setVisible(previous => previous.join('|') === ids.join('|') ? previous : ids) }
    const observer = new ResizeObserver(schedule); observer.observe(root); if (root.firstElementChild) observer.observe(root.firstElementChild)
    root.addEventListener('scroll', scroll, { passive: true }); schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); root.removeEventListener('scroll', scroll) }
  }, [scope, signature, scroller])
  const shown = entries.find(entry => entry.id === preview), point = points.find(point => point.id === preview)
  // Fixed-density index. Only group messages when the actual available height is exhausted.
  const buckets = conversationIndexRows(points.map(point => point.id), railHeight)
  const ridge = buckets.find(row => row.ids.includes(preview || ''))?.top
  const focusId = preview || active || points[0]?.id
  useLayoutEffect(() => {
    const box = previewBox.current, root = nav.current
    const row = buckets.find(row => row.ids.includes(preview || ''))
    if (box && root && row) box.style.top = Math.max(0, Math.min(root.clientHeight - box.offsetHeight, row.top + 5 - box.offsetHeight / 2)) + 'px'
  }, [preview, shown?.prompt, shown?.reply, railHeight, points.length])
  if (points.length < 2) return null
  const jump = (id: string) => {
    const root = scroller.current, target = root?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`); if (!root || !target) return
    onMove.current(); root.scrollTo({ top: target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); setActive(id)
  }
  return <nav ref={nav} className="conversation-nodes" aria-label={t('对话节点')} onMouseLeave={() => { if (!nav.current?.contains(document.activeElement)) setPreview(null) }} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPreview(null) }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setPreview(null); scroller.current?.focus({ preventScroll: true }); return }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = Math.max(0, points.findIndex(point => point.id === focusId))
    const next = event.key === 'Home' ? points[0] : event.key === 'End' ? points.at(-1)! : points[Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    const marker = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.conversation-node')].find(button => button.dataset.ids?.split('|').includes(next.id))
    marker?.focus({ preventScroll: true }); setPreview(next.id)
  }}>
    {buckets.map(({ top, ids }) => { const distance = ridge === undefined ? undefined : top - ridge; const weight = distance === undefined ? 0 : conversationNodeWeight(distance); const tone = distance === undefined ? 0 : conversationNodeTone(distance); return <button key={ids[0]} data-ids={ids.join('|')} tabIndex={ids.includes(focusId || '') ? 0 : -1} className={'conversation-node' + (ids.some(id => visible.includes(id)) ? ' in-view' : '') + (ids.some(id => saved.includes(id)) ? ' saved' : '')} style={{ top }} aria-label={entries.find(entry => entry.id === ids[0])?.prompt || t('跳转到消息')} aria-current={ids.includes(active) ? 'location' : undefined} onMouseEnter={() => setPreview(ids[0])} onFocus={() => setPreview(ids[0])} onClick={() => jump(ids.includes(preview || '') ? preview! : ids[0])}><span style={{width:6 + 18 * weight,'--node-tone':tone} as CSSProperties}/></button> })}
    {shown && point && <div ref={previewBox} className="node-preview"><div><button className="node-prompt" onClick={() => jump(shown.id)}>{shown.prompt}</button><button className="node-bookmark" aria-label={saved.includes(shown.id) ? t('取消书签') : t('添加书签')} aria-pressed={saved.includes(shown.id)} onClick={() => { const next = saved.includes(shown.id) ? saved.filter(id => id !== shown.id) : [...saved, shown.id]; setSaved(next); localStorage.setItem(`nodes:${scope}`, JSON.stringify(next)) }}><Bookmark size={15} fill={saved.includes(shown.id) ? 'currentColor' : 'none'} /></button></div>{shown.reply?.trim() && <p className="node-reply">{shown.reply.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(^|\n)\s*[#>*-]+\s*/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()}</p>}</div>}
  </nav>
}
