import { CopyButton } from './transcript/CopyButton'
import { TurnDisclosure } from './transcript/TurnDisclosure'
import { TurnFooter } from './transcript/TurnFooter'
import { ConversationNodes } from './ConversationNodes'
import { conversationIndexEntries } from '@shared/conversationIndex'
import { remarkCjkEmphasis } from '@shared/remarkCjkEmphasis'
import { isAtBottom } from '@shared/scrollPosition'
import { ToolRunView } from './transcript/TurnTools'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openInFileManager, routeFor } from '../actions'
import { StatusChip } from './StatusChip'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { OutputCard } from './Outputs'
import { InteractivePreview } from './InteractivePreview'
import { PeerCard } from './PeerCard'
import { WorkingMark } from './WorkingMark'
import {
  AppWindow,
  Check,
  ChevronLeft,
  ChevronRight,
  MessagesSquare,
  Pencil,
  CornerUpLeft,
  Split,
  PackageOpen,
  FolderOpen,
  CircleHelp,
  CornerUpRight
} from 'lucide-react'
import { currentBlocker, type Block, type Conversation, type Message } from '@shared/model'
import { PlanLine, planHeadline } from './PlanLine'
import { api, openFileInApp, refreshAccount, useApp } from '../store'
import { dayLabel, imeComposing, textOf } from '../util'
import { markdownParts } from '../markdownParts'
import { AttachmentChip } from './Composer'
import { t } from '../i18n'
import { LoginButton, TerminalLoginButton } from './Dialogs'
import { classifyError, errorLead, type ErrorKind } from '@shared/errors'

import { hasReplyContent, segmentBlocks, visualWork } from '../turn'
import { limitSentence, turnNote, type TurnNoteView } from '../turnNote'

export function Transcript({ conversation, compact, header, footer }: { conversation: Conversation; compact?: boolean; header?: React.ReactNode; footer?: React.ReactNode }) {
  const messages = useApp((s) => s.messages[conversation.id])
  const loadMessages = useApp((s) => s.loadMessages)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const touched = useRef(-Infinity)
  const direction = useRef(0)
  const touchY = useRef<number | undefined>(undefined)
  const lastUser = useRef<string | undefined>(undefined)
  const seenConversation = useRef('')
  const userScroll = (delta: number) => {
    if (!Number.isFinite(delta)) return
    touched.current = performance.now()
    direction.current = Math.sign(delta)
    // Stop before layout/resize callbacks get a chance to pull the viewport back.
    if (delta <= 0) stick.current = false
    else {
      // A sandbox's wheel intent crosses postMessage and can arrive after the
      // parent has already scrolled. In that order no later scroll event will
      // resume following, so also reconcile the confirmed intent here.
      const el = scroller.current
      if (el && isAtBottom(el, 4)) stick.current = true
    }
  }

  useEffect(() => {
    void loadMessages(conversation.id)
    stick.current = true
  }, [conversation.id, loadMessages])

  useEffect(() => {
    if (conversation.unread) void api().updateConversation(conversation.id, { unread: false })
  }, [conversation.id, conversation.unread, messages?.length])

  useLayoutEffect(() => {
    if (seenConversation.current !== conversation.id) {
      seenConversation.current = conversation.id
      lastUser.current = undefined
      stick.current = true
    }
    const newest = (messages ?? []).findLast((m) => m.role === 'user' && !m.hidden)?.id
    if (lastUser.current && newest && newest !== lastUser.current) stick.current = true
    lastUser.current = newest
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, conversation.id, compact])

  // Anything else that changes the height (a card unfolding, an image arriving, the composer
  // growing) keeps the view at the bottom too, if it was there.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      ro.disconnect()
    }
  }, [])

  // Wheel/touch events do not bubble across sandbox boundaries. Accept intent
  // only from one of this transcript's own frames.
  useEffect(() => {
    const intent = (e: MessageEvent) => {
      if (e.data?.type !== 'fenn:ui-scroll' || typeof e.data.deltaY !== 'number') return
      const frames = scroller.current?.querySelectorAll('iframe') ?? []
      if ([...frames].some((f) => f.contentWindow === e.source)) userScroll(e.data.deltaY)
    }
    window.addEventListener('message', intent)
    return () => window.removeEventListener('message', intent)
  }, [])

  const visible = (messages ?? []).filter((m) => !m.hidden && !(m.role === 'assistant' && m.state === 'done' && !m.action && !hasReplyContent(m.blocks)))
  let lastDay = ''

  // Arriving from a search hit: scroll to that message and flash it.
  const focus = useApp((s) => s.focusMessage)
  useEffect(() => {
    if (!focus || !visible.some((m) => m.id === focus)) return
    const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${focus}"]`)
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    el.classList.add('flash')
    // Off again when its animation (timed in CSS, --dur-flash) has played.
    const done = (e: AnimationEvent) => e.animationName === 'flash' && (el.classList.remove('flash'), el.removeEventListener('animationend', done))
    el.addEventListener('animationend', done)
    useApp.getState().set({ focusMessage: null })
  })

  return (
    <div className="transcript-shell">
    <div
      className="scroll"
      ref={scroller}
      onWheel={(e) => userScroll(e.deltaY)}
      onTouchStart={(e) => { touchY.current = e.touches[0]?.clientY }}
      onTouchMove={(e) => {
        const next = e.touches[0]?.clientY
        if (next !== undefined && touchY.current !== undefined) userScroll(touchY.current - next)
        touchY.current = next
      }}
      onPointerDown={(e) => userScroll(e.target === e.currentTarget ? 0 : -1)}
      onKeyDown={(e) => {
        if ((e.target as Element).closest('input,textarea,select,[contenteditable=true]')) return
        if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) userScroll(-1)
        else if (['ArrowDown', 'PageDown', 'End'].includes(e.key)) userScroll(1)
      }}
      onScroll={(e) => {
        const el = e.currentTarget
        const atBottom = isAtBottom(el, 4)
        // Layout clamping and iframe resizing are not a request to resume.
        if (atBottom && direction.current >= 0 && performance.now() - touched.current < 500) stick.current = true
      }}
    >
      <div className="transcript">
        {header}
        {visible.map((m, idx) => {
          const day = dayLabel(m.createdAt)
          const divider = !compact && day !== lastDay
          lastDay = day
          return (
            <div key={m.id} data-mid={m.id}>
              {divider && <div className="day-divider">{day}</div>}
              <MessageView
                message={m}
                last={idx === visible.length - 1}
                busy={conversation.status === 'working'}
                showFooter={visible[idx + 1]?.role !== 'assistant' || !!m.action || !!visible[idx + 1]?.action}
              />
            </div>
          )
        })}
        {footer}
        <PlanLine key={conversation.id} conv={conversation} />
      </div>
    </div>
    <ConversationNodes key={conversation.id} scope={`code:${conversation.id}`} scroller={scroller} onNavigate={() => userScroll(-1)} entries={conversationIndexEntries(visible.map(message => ({id:message.id,role:message.role,text:textOf(message)})))} />
    </div>
  )
}

export const MessageView = memo(function MessageView({
  message: m,
  last,
  busy,
  showFooter = true
}: {
  message: Message
  last?: boolean
  busy?: boolean
  showFooter?: boolean
}) {
  if (m.role === 'system') {
    const ev = m.blocks.find((b): b is Extract<Block, { type: 'thread-event' }> => b.type === 'thread-event')
    if (ev) return <ThreadEventLine ev={ev} />
    const peer = m.blocks.find((b): b is Extract<Block, { type: 'peer-message' }> => b.type === 'peer-message')
    if (peer)
      return (
        <div className="msg msg-peer">
          <PeerCard peerId={peer.peerId} direction={peer.direction} />
        </div>
      )
    return <div className="msg msg-system">{textOf(m)}</div>
  }
  // A button's turn (压缩上下文) reads as one line; only a failure shows the reply.
  if (m.action) {
    if (m.role === 'user') return null
    const line = <div className="day-divider">{m.state === 'streaming' ? <span className="shimmer">{t('正在压缩上下文…')}</span> : m.state === 'done' ? t('已压缩上下文') : t('压缩上下文')}</div>
    if (m.state === 'streaming' || m.state === 'done') return line
    return (
      <>
        {line}
        <AssistantMessage m={m} last={last} busy={busy} showFooter={showFooter} />
      </>
    )
  }
  if (m.role === 'user') return <UserMessage m={m} busy={busy} />
  return <AssistantMessage m={m} last={last} busy={busy} showFooter={showFooter} />
})

/** Historical explicit forwards and pending decisions open their original thread. */
function ThreadEventLine({ ev }: { ev: Extract<Block, { type: 'thread-event' }> }) {
  const thread = useApp((s) => s.conversations.find((c) => c.id === ev.threadId))
  const navigate = useApp((s) => s.navigate)
  if (!thread?.projectId) return null
  // A decision line greys once the user chose (or a newer question replaced it).
  const settled = thread.resolved || (ev.kind === 'decision' && ev.at !== undefined && thread.needsUser?.at !== ev.at)
  return (
    <button
      className={'thread-event kind-' + ev.kind + (settled ? ' settled' : '')}
      onClick={() => navigate(routeFor(thread))}
    >
      {ev.kind === 'forwarded' ? <CornerUpRight size={14} /> : <CircleHelp size={14} />}
      <span className="ellipsis">{ev.kind === 'forwarded' ? t('已转给「{0}」：{1}', thread.title, ev.text) : t('「{0}」需要您决定：{1}', thread.title, ev.text)}</span>
      <ChevronRight size={14} className="muted" />
    </button>
  )
}

/** "已发送到讨论串" under a project-chat message the coordinator passed on; opens that thread. */
function ForwardedNote({ m }: { m: Message }) {
  const thread = useApp((s) => s.conversations.find((c) => c.id === m.forwardedTo))
  const navigate = useApp((s) => s.navigate)
  if (!thread?.projectId) return null
  return (
    <button className="forwarded" onClick={() => navigate(routeFor(thread))}>
      <CornerUpLeft size={12} />
      {t('已发送到讨论串')}
    </button>
  )
}

function UserMessage({ m, busy }: { m: Message; busy?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null)
  const files = m.blocks.filter((b): b is Extract<Block, { type: 'attachment' }> => b.type === 'attachment')
  const text = textOf(m)
  if (editing !== null) {
    const save = () => {
      const t = editing.trim()
      setEditing(null)
      if (t && t !== text) void api().editMessage(m.conversationId, m.id, t)
    }
    return (
      <div className="msg msg-user">
        <div className="edit-box">
          <textarea
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !imeComposing(e)) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') (e.preventDefault(), setEditing(null))
            }}
          />
          <div className="edit-actions">
            <span className="small muted">{t('保存后会从这里重新回答，原来的版本会保留')}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => setEditing(null)}>
              {t('取消')}</button>
            <button className="btn primary" onClick={save}>
              {t('保存')}</button>
          </div>
        </div>
      </div>
    )
  }
  const actions = (
    <div className="msg-actions">
      {m.variant && m.variant.count > 1 && <VersionSwitch m={m} busy={busy} />}
      {!!text && <CopyButton text={text} />}
      {!busy && !!text && (
        <button className="icon-btn sm" data-tip={t('编辑')} onClick={() => setEditing(text)}>
          <Pencil size={14} />
        </button>
      )}
    </div>
  )
  return (
    <div className="msg msg-user">
      {files.length > 0 && (
        <div className="msg-attachments">
          {files.map((b, i) =>
            b.attachment.kind === 'image' && b.attachment.data ? (
              <img
                key={i}
                className="full"
                alt={b.attachment.name}
                src={`data:${b.attachment.mimeType};base64,${b.attachment.data}`}
              />
            ) : (
              <AttachmentChip key={i} a={b.attachment} />
            )
          )}
        </div>
      )}
      {/* Its actions sit beside the bubble, so they never cover the message below. */}
      {text && (
        <div className="bubble-row">
          {actions}
          <div className="bubble">{commandToken(text)}</div>
        </div>
      )}
      {m.forwardedTo && <ForwardedNote m={m} />}
      {!!m.references?.length && <ConversationReferences message={m} />}
      {/* What a / command started from this message (a sub-chat, a thread). */}
      {m.blocks.some((b) => b.type === 'thread-card') && (
        <div className="user-cards">
          {m.blocks.map((b, i) => (b.type === 'thread-card' ? <ThreadCard key={i} threadId={b.threadId} /> : null))}
        </div>
      )}
      {/* The agent's emoji answer to this message (e.g. 👍 for thanks). */}
      {!text && actions}
    </div>
  )
}

/** References are inspectable context; clicking one only navigates. */
function ConversationReferences({ message }: { message: Message }) {
  const conversations = useApp((s) => s.conversations)
  const navigate = useApp((s) => s.navigate)
  return <div className="message-references" aria-label={t('引用对话')}>
    {message.references!.map((reference) => {
      const conversation = conversations.find((c) => c.id === reference.id)
      return <button className="conversation-reference" key={reference.id} disabled={!conversation} onClick={() => { if (conversation) navigate(routeFor(conversation)) }}><MessagesSquare size={13} /><span>@{conversation?.title ?? reference.title}</span></button>
    })}
  </div>
}

/** ‹ 2 / 3 ›: the versions of an edited or regenerated turn, as in Claude. */
function VersionSwitch({ m, busy }: { m: Message; busy?: boolean }) {
  const v = m.variant!
  const go = (i: number) => void api().switchVariant(m.conversationId, v.group, i)
  return (
    <span className="version-switch">
      <button className="icon-btn sm" data-tip={t('上一个版本')} disabled={busy || v.index === 0} onClick={() => go(v.index - 1)}>
        <ChevronLeft size={14} />
      </button>
      <span className="small muted">
        {v.index + 1} / {v.count}
      </span>
      <button className="icon-btn sm" data-tip={t('下一个版本')} disabled={busy || v.index === v.count - 1} onClick={() => go(v.index + 1)}>
        <ChevronRight size={14} />
      </button>
    </span>
  )
}

function AssistantMessage({ m, last, busy, showFooter = true }: { m: Message; last?: boolean; busy?: boolean; showFooter?: boolean }) {
  const streaming = m.state === 'streaming'
  const connecting = m.blocks.find((b): b is Extract<Block, { type: 'notice' }> => b.type === 'notice' && b.key === 'starting')
  const groups = segmentBlocks(m.blocks)
  const making = visualWork(m.blocks)
  const inProjectChat = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.kind === 'project')
  if (!streaming && m.state === 'done' && groups.length === 0) return null
  const canThread = inProjectChat && !busy && !m.blocks.some((b) => b.type === 'thread-card') && !(m.state === 'done' && suggestsThread(m, inProjectChat, last, busy))
  const canRegenerate = last && !busy && !m.blocks.some((b) => b.type === 'thread-card') && m.state !== 'error' && !(m.interrupted && !m.switchedTo)


  return (
    <div className={'msg msg-assistant turn' + (streaming ? ' streaming' : '')}>
      {groups.map((g, i) => {
        const live = streaming && i === groups.length - 1
        switch (g.type) {
          case 'thought':
            return <ThoughtFold key={i} block={g} live={live} />
          case 'tools':
            return <ToolRunView key={i} tools={g.tools} live={live} ended={!streaming} />
          case 'plan':
            return <PlanFold key={i} entries={g.entries} />
          case 'text':
            return <Markdown key={i} text={g.text} />
          case 'notice':
            // 「正在连接…」 is the waiting line itself, not a note in the reply.
            if (g.key === 'starting') return null
            return (
              <div key={i} className={'notice ' + g.level}>
                {g.text}
              </div>
            )
          case 'placed':
            return <PlacedLine key={i} path={g.path} />
          case 'thread-card':
            return <ThreadCard key={i} threadId={g.threadId} />
          case 'artifact':
            return g.display === 'inline'
              ? <InteractivePreview key={i} id={g.artifactId} title={g.title} version={g.version} />
              : <PageCard key={i} id={g.artifactId} title={g.title} version={g.version} />
          case 'output':
            return <OutputCard key={i} o={{ ...g, conversationId: m.conversationId }} />
          case 'decision':
            return <DecisionCard key={i} m={m} index={m.blocks.indexOf(g)} d={g} />
          case 'peer-message':
            return <PeerCard key={i} peerId={g.peerId} direction={g.direction} />
          default:
            return null
        }
      })}
      {streaming && <WorkingMark since={m.createdAt} label={connecting?.text ?? (making === 'visualization' ? t('正在制作可视化…') : making === 'page' ? t('正在编写界面…') : undefined)} />}
      {/* A / command the agent carried out without a word (Grok's /always-approve). */}
      {!streaming && m.state === 'done' && !m.blocks.length && <div className="small muted">{t('没有返回内容')}</div>}
      {m.editedAt && (
        <div className="edited-mark small muted" data-tip={new Date(m.editedAt).toLocaleString()}>
          {t('已编辑')}
        </div>
      )}
      {(m.state === 'error' || m.state === 'cancelled') && <TurnEnd m={m} last={last} busy={busy} />}
      {!streaming && m.state === 'done' && <ThreadSuggestion m={m} last={last} busy={busy} />}
      {!streaming && showFooter && !(last && busy) && (
        <TurnFooter message={m} canThread={canThread} canRegenerate={canRegenerate} />
      )}
    </div>
  )
}

/** The path a link points to when it is a file on this computer (file://, C:\\…, /…), else undefined. */
function localFile(href?: string): string | undefined {
  if (!href) return undefined
  if (/^file:/i.test(href)) {
    try {
      const p = decodeURIComponent(new URL(href).pathname)
      return /^\/[a-zA-Z]:\//.test(p) ? p.slice(1).replace(/\//g, '\\') : p
    } catch {
      return undefined
    }
  }
  return /^([a-zA-Z]:[\\/]|\/(?!\/))/.test(href) ? decodeURIComponent(href) : undefined
}

/** Links that may leave the app: to the browser or the mail app. Anything else never goes to the system. */
const WEB_LINK = /^(https?:|mailto:)/i

/** Keeps file: links (react-markdown would blank them) so they can open in the app; the rest as react-markdown cleans them. */
const keepFileLinks = (url: string) => (/^file:/i.test(url) ? url : defaultUrlTransform(url))

const MD_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const file = localFile(href)
    // A file on this computer opens in the app, beside the chat; a web link in the browser.
    // A relative link, or any other scheme, is shown as text: it would resolve against the app itself.
    if (!file && !(href && WEB_LINK.test(href))) return <span>{children}</span>
    return file ? (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          openFileInApp(file)
        }}
      >
        {children}
      </a>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  },
  pre: ({ children }: { children?: React.ReactNode }) => <CodeBlock>{children}</CodeBlock>
}

/** One piece of a reply; unchanged pieces are not parsed again while the reply streams. */
const MarkdownPart = memo(function MarkdownPart({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkEmphasis]} components={MD_COMPONENTS} urlTransform={keepFileLinks}>
      {text}
    </ReactMarkdown>
  )
})

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {markdownParts(text).map((part, i) => (
        <MarkdownPart key={i} text={part} />
      ))}
    </div>
  )
})

/** A message that starts with a / command shows the command as a token, not as plain text. */
function commandToken(text: string): React.ReactNode {
  const m = /^\/([^\s/]+)(\s[\s\S]*)?$/.exec(text)
  if (!m) return text
  return (
    <>
      <span className="cmd-token">/{m[1]}</span>
      {m[2] ?? ''}
    </>
  )
}

function PageCard({ id, title, version }: { id: string; title: string; version: number }) {
  const open = useApp((s) => s.page?.id === id && (s.page.version ?? version) === version)
  return (
    <button className={'page-card' + (open ? ' open' : '')} onClick={() => useApp.getState().set({ page: { id, version }, fileView: null })}>
      <span className="page-card-icon">
        <AppWindow size={18} />
      </span>
      <span className="page-card-text">
        <span className="t">{title}</span>
        <span className="small muted">{t('页面')}{version > 1 ? t(' · 版本 {0}', version) : ''} {' '}{t('· 点击打开')}</span>
      </span>
    </button>
  )
}

/** A question with options, one recommended; tapping one answers the agent. */
function DecisionCard({ m, index, d }: { m: Message; index: number; d: Extract<Block, { type: 'decision' }> }) {
  const answered = d.chosen !== undefined
  return (
    <div className="decision">
      <div className="decision-q">{d.question}</div>
      {d.context && <div className="decision-ctx">{d.context}</div>}
      <div className="decision-opts">
        {d.options.map((o, i) => (
          <button
            key={i}
            className={'decision-opt' + (d.chosen === i ? ' chosen' : '') + (answered && d.chosen !== i ? ' faded' : '')}
            disabled={answered}
            onClick={() => api().chooseDecision(m.conversationId, m.id, index, i)}
          >
            <span className="label">
              {o.label}
              {i === d.recommended && <span className="rec">{t('推荐')}</span>}
              {d.chosen === i && <Check size={13} />}
            </span>
            <span className="cons">{o.consequence}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Readable labels for the app's computer-control tools. */
/** A title naming a file by its whole path (「Read `C:\\Users\\…\\plan.md`」) names it by its file name. */
/** One bout of thinking: 「思考了 6 秒」, folded; it opens to what the agent thought. */
function ThoughtFold({ block, live }: { block: Extract<Block, { type: 'thought' }>; live: boolean }) {
  const label = live ? t('思考中…') : block.ms == null ? t('思考过程') : block.ms >= 1000 ? t('思考了 {0} 秒', Math.round(block.ms / 1000)) : t('思考了片刻')
  return (
    <TurnDisclosure label={label} live={live}>
      <div className="step-thought">
        <Markdown text={block.text.trim()} />
      </div>
    </TurnDisclosure>
  )
}

/** The agent's plan for the turn, folded: 「计划 2/5」 while under way, 「计划已完成 5/5」 once every step is done. */
function PlanFold({ entries }: { entries: Extract<Block, { type: 'plan' }>['entries'] }) {
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <TurnDisclosure label={done === entries.length ? t('计划已完成 {0}/{1}', done, entries.length) : t('计划 {0}/{1}', done, entries.length)}>
      <Plan entries={entries} />
    </TurnDisclosure>
  )
}

function Plan({ entries }: { entries: Extract<Block, { type: 'plan' }>['entries'] }) {
  return (
    <div className="plan">
      {entries.map((e, i) => (
        <div key={i} className={'plan-item ' + e.status}>
          <span className="mark">{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '✱' : '○'}</span>
          <span>{e.content}</span>
        </div>
      ))}
    </div>
  )
}

function ThreadCard({ threadId }: { threadId: string }) {
  const thread = useApp((s) => s.conversations.find((c) => c.id === threadId))
  const outputs = useApp((s) => s.projects.find((p) => p.id === thread?.projectId)?.outputs?.filter((o) => o.conversationId === threadId).length ?? 0)
  const navigate = useApp((s) => s.navigate)
  if (!thread) return null
  const headline = planHeadline(thread)
  return (
    <button
      className="thread-card"
      onClick={() => navigate(routeFor(thread))}
    >
      <MessagesSquare size={15} className="muted" />
      <span className="t">{thread.title}</span>
      {!!thread.messageCount && <span className="small muted">{t('{0} 条回复', thread.messageCount)}</span>}
      {outputs > 0 && (
        <span className="thread-outputs" data-tip={t('{0} 份成果', outputs)}>
          <PackageOpen size={12} />
          {outputs}
        </span>
      )}
      <StatusChip conv={thread} />
      {headline && !thread.resolved && <span className={'plan-headline' + (currentBlocker(thread) ? ' blocked' : '')}>{headline}</span>}
    </button>
  )
}

/** A fenced code block with its language and a copy button, like Claude's. */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const child = Array.isArray(children) ? children[0] : children
  const cls = (child as { props?: { className?: string } } | undefined)?.props?.className ?? ''
  const lang = /language-([\w+#-]+)/.exec(cls)?.[1]
  const [text, setText] = useState('')
  useEffect(() => setText(ref.current?.innerText ?? ''), [children])
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ?? t('代码')}</span>
        <CopyButton text={text} />
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

export function Checklist({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="checklist">
      {lines.map((l, i) => {
        const clean = l.replace(/\*\*/g, '')
        const cls = i === 0 && !/^[✓✱○]/.test(clean.trim()) ? 'head' : clean.startsWith('✓') ? 'done' : clean.startsWith('✱') ? 'doing' : ''
        return (
          <div key={i} className={cls} style={l.includes('**') ? { fontWeight: 600 } : undefined}>
            {clean || ' '}
          </div>
        )
      })}
    </div>
  )
}

/**
 * How a reply that ended early or failed ends: a quiet note (已停止, 已中断, a usage limit
 * that lifts by itself; see turnNote) or, for a failure the user can fix, the error bar.
 */
function TurnEnd({ m, last, busy }: { m: Message; last?: boolean; busy?: boolean }) {
  const resumes = useApp((s) => {
    const c = s.conversations.find((x) => x.id === m.conversationId)
    return c?.kind === 'thread' && !c.resolved
  })
  const agent = useBackendName(m.conversationId)
  const note = turnNote(m, { agent, last, busy, resumes })
  if (note) return <TurnNote note={note} onRetry={() => void api().regenerate(m.conversationId)} />
  return m.state === 'error' ? <ErrorBar m={m} last={last} busy={busy} /> : null
}

/** One muted line under the turn, with 重试 beside it where that applies. */
function TurnNote({ note, onRetry }: { note: TurnNoteView; onRetry: () => void }) {
  return (
    <div className={'turn-note ' + note.kind} role="status">
      <span data-tip={note.tip}>{note.text}</span>
      {note.retry && (
        <button className="link" onClick={onRetry}>
          {t('重试')}
        </button>
      )}
    </div>
  )
}

/** The name of the agent a conversation talks to, for sentences about it. */
function useBackendName(conversationId: string): string {
  return useApp((s) => {
    const backendId = s.conversations.find((c) => c.id === conversationId)?.backendId
    return s.backends.find((b) => b.id === backendId)?.name ?? 'Agent'
  })
}

/** Plain-language wording for each recognised failure; the agent's own text stays under 「详情」. */
function errorSentence(kind: ErrorKind, name: string, how: string, raw: string): string {
  switch (kind) {
    case 'limit':
      // Usually shown as a TurnNote instead; kept for a limit message the app reworded.
      return limitSentence(name, raw)
    case 'filesystem':
      return t('{0} 无法读写本地文件。请查看详情中的路径，并检查文件权限或系统访问限制。', name)
    case 'refresh':
      return t('{0} 的登录需要刷新。', name) + how + t('如果刚登录过，稍等一分钟再重试。')
    case 'auth':
      return t('{0} 需要登录，或者登录已过期。', name) + how
    case 'forbidden':
      return t('{0} 拒绝了这次请求，可能是账号没有权限使用这个模型。', name)
    case 'quota':
      return t('{0} 的额度用完了，请到它的官网查看账户余额或套餐。', name)
    case 'rate':
      return t('{0} 现在太忙或请求太频繁，请稍等一会儿再重试。', name)
    case 'network':
      return t('连不上 {0} 的服务。请检查网络和代理设置，然后重试。', name)
    case 'timeout':
      return t('{0} 太久没有回应，请稍后重试。', name)
    case 'server':
      return t('{0} 的服务暂时出了问题，请稍后重试。', name)
  }
}

/** A failed reply, with the one action that fixes the common cases (sign in, retry). */
export function ErrorBar({ m, last = true, busy }: { m: Message; last?: boolean; busy?: boolean }) {
  const backendId = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.backendId)
  const backend = useApp((s) => s.backends.find((b) => b.id === backendId))
  const raw = m.error ?? ''
  const kind = classifyError(raw)
  const name = backend?.name ?? 'Agent'
  const secret = backend?.settings.find((x) => x.secret)
  const canLogin = !!(backend?.signIn || backend?.terminalLogin)
  const how = canLogin ? t('点下方「登录」，完成后点「重试」。') : secret ? t('请在设置里填写「{0}」，然后重试。', secret.label) : t('请按它的说明登录后重试。')
  // Messages the app wrote itself are already in plain Chinese; only the agent's raw text gets reworded, and
  // text the app doesn't recognise is never shown as it is: it stays under 「详情」, as does anything after a first line.
  const lead = errorLead(raw)
  const reworded = !lead ? null : 'line' in lead ? lead.line : kind ? errorSentence(kind, name, how, raw) : t('{0} 没能完成这次回复。', name)
  const needsLogin = (kind === 'auth' || kind === 'refresh') && !!backend
  return (
    <div className="msg-error">
      <div>
        {t('出错了：')}
        {reworded ?? (raw || t('未知错误'))}
      </div>
      {reworded && (
        <details className="msg-error-detail">
          <summary>{t('详情')}</summary>
          <code>{raw}</code>
        </details>
      )}
      <div className="msg-error-actions">
        {needsLogin && backend.signIn && <LoginButton backendId={backend.id} label={t('登录')} onDone={() => void api().regenerate(m.conversationId)} />}
        {needsLogin && !backend.signIn && backend.terminalLogin && <TerminalLoginButton backendId={backend.id} />}
        {needsLogin && secret && (
          <button className="btn" onClick={() => useApp.getState().set({ settingsOpen: 'backends' })}>
            {t('打开设置')}</button>
        )}
        {last && !busy && (
          <button className="btn" onClick={() => {
            // Signed in elsewhere since: the composer's 未登录 should hear about it too.
            if (needsLogin) void refreshAccount(backend.id)
            void api().regenerate(m.conversationId)
          }}>
            {t('重试')}</button>
        )}
      </div>
    </div>
  )
}

/** A long answer in the project chat that could have been a thread (see ThreadSuggestion). */
function suggestsThread(m: Message, inProjectChat: boolean, last?: boolean, busy?: boolean): boolean {
  return inProjectChat && !!last && !busy && !m.blocks.some((b) => b.type === 'thread-card') && textOf(m).length >= 400
}

/**
 * When the coordinator answered a substantial request inline instead of
 * starting a thread (weaker models often do), offer to move it into one.
 */
function ThreadSuggestion({ m, last, busy }: { m: Message; last?: boolean; busy?: boolean }) {
  const inProjectChat = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.kind === 'project')
  const [sent, setSent] = useState(false)
  if (sent || !suggestsThread(m, inProjectChat, last, busy)) return null
  return (
    <div className="thread-suggestion">
      <Split size={14} />
      <span>{t('这件事可以交给一个讨论串单独推进，进度会显示在右侧。')}</span>
      <button
        className="btn"
        onClick={() => {
          setSent(true)
          void api().convertToThread(m.conversationId, m.id)
        }}
      >
        {t('转为讨论串')}</button>
    </div>
  )
}

/** 「已放在 <文件夹>」: the chat made files, so the app gave it a folder of its own. */
function PlacedLine({ path }: { path: string }) {
  const platform = useApp((s) => s.platform)
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
  const open = () => openInFileManager(path)
  return (
    <div className="placed-line">
      <FolderOpen size={14} />
      <span data-tip={path}>{t('已放在 {0}', name)}</span>
      <button className="link" onClick={open}>
        {platform === 'darwin' ? t('在访达中打开') : platform === 'win32' ? t('在资源管理器中打开') : t('打开文件夹')}
      </button>
    </div>
  )
}
