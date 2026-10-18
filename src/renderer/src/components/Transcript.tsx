import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { openInFileManager, routeFor } from '../actions'
import { StatusChip } from './StatusChip'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MessageUsageLabel } from './Usage'
import { OutputCard } from './Outputs'
import { PeerCard } from './PeerCard'
import {
  AppWindow,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  FileText,
  Globe,
  Loader,
  MessagesSquare,
  MousePointerClick,
  Pencil,
  RotateCcw,
  Search,
  SmilePlus,
  SquareTerminal,
  Wrench,
  CornerUpLeft,
  Split,
  PackageOpen,
  FolderOpen,
  CircleHelp,
  CornerUpRight
} from 'lucide-react'
import { currentBlocker, type Block, type Conversation, type Message } from '@shared/model'
import { planHeadline } from './PlanLine'
import { api, openFileInApp, refreshAccount, useApp } from '../store'
import { dayLabel, imeComposing, textOf } from '../util'
import { markdownParts } from '../markdownParts'
import { useMenu } from './Menu'
import { AttachmentChip } from './Composer'
import { t } from '../i18n'
import { LoginButton, TerminalLoginButton } from './Dialogs'
import { classifyError, isFriendly, limitResetIn, type ErrorKind } from '@shared/errors'

import { segmentBlocks, type ToolBlock } from '../turn'

export function Transcript({ conversation, compact, header }: { conversation: Conversation; compact?: boolean; header?: React.ReactNode }) {
  const messages = useApp((s) => s.messages[conversation.id])
  const loadMessages = useApp((s) => s.loadMessages)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    void loadMessages(conversation.id)
    stick.current = true
  }, [conversation.id, loadMessages])

  useEffect(() => {
    if (conversation.unread) void api().updateConversation(conversation.id, { unread: false })
  }, [conversation.id, conversation.unread, messages?.length])

  useLayoutEffect(() => {
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
    return () => ro.disconnect()
  }, [])

  // Only the user's own scrolling decides whether to follow the bottom; a jump in height
  // between two frames (a reply cut short, a long block arriving) is not them scrolling away.
  const touched = useRef(0)
  const byUser = () => (touched.current = performance.now())

  const visible = (messages ?? []).filter((m) => !m.hidden)
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
    setTimeout(() => el.classList.remove('flash'), 1600)
    useApp.getState().set({ focusMessage: null })
  })

  return (
    <div
      className="scroll"
      ref={scroller}
      onWheel={byUser}
      onTouchMove={byUser}
      onPointerDown={byUser}
      onKeyDown={byUser}
      onScroll={(e) => {
        const el = e.currentTarget
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        if (atBottom || performance.now() - touched.current < 800) stick.current = atBottom
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
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const MessageView = memo(function MessageView({
  message: m,
  last,
  busy
}: {
  message: Message
  last?: boolean
  busy?: boolean
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
        <AssistantMessage m={m} last={last} busy={busy} />
      </>
    )
  }
  if (m.role === 'user') return <UserMessage m={m} busy={busy} />
  return <AssistantMessage m={m} last={last} busy={busy} />
})

/** In the project chat: a thread waits for the user's decision, or the user sent it a message with @; opens that thread. */
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
      {/* What a / command started from this message (a sub-chat, a thread). */}
      {m.blocks.some((b) => b.type === 'thread-card') && (
        <div className="user-cards">
          {m.blocks.map((b, i) => (b.type === 'thread-card' ? <ThreadCard key={i} threadId={b.threadId} /> : null))}
        </div>
      )}
      {/* The agent's emoji answer to this message (e.g. 👍 for thanks). */}
      {!!m.reactions?.length && (
        <div className="reactions on-user">
          {m.reactions.map((r) => (
            <span key={r} className="reaction" data-tip={t('Agent 的回应')}>
              {r}
            </span>
          ))}
        </div>
      )}
      {!text && actions}
    </div>
  )
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

function AssistantMessage({ m, last, busy }: { m: Message; last?: boolean; busy?: boolean }) {
  const streaming = m.state === 'streaming'
  const connecting = m.blocks.find((b): b is Extract<Block, { type: 'notice' }> => b.type === 'notice' && b.key === 'starting')
  const groups = segmentBlocks(m.blocks)
  const [menu, openMenu] = useMenu({ row: true, placement: 'auto' })
  const inProjectChat = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.kind === 'project')
  if (!streaming && m.state === 'done' && groups.length === 0 && !m.reactions?.length) return null

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
            return <PageCard key={i} id={g.artifactId} title={g.title} version={g.version} />
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
      {streaming && <WorkingMark since={m.createdAt} label={connecting?.text} />}
      {/* A / command the agent carried out without a word (Grok's /always-approve). */}
      {!streaming && m.state === 'done' && !m.blocks.length && <div className="small muted">{t('没有返回内容')}</div>}
      {m.editedAt && (
        <div className="edited-mark small muted" data-tip={new Date(m.editedAt).toLocaleString()}>
          {t('已编辑')}
        </div>
      )}
      {m.state === 'error' && <ErrorBar m={m} last={last} busy={busy} />}
      {!streaming && m.state === 'done' && <ThreadSuggestion m={m} last={last} busy={busy} />}
      {m.state === 'cancelled' && <Stopped m={m} last={last} />}
      {!!m.reactions?.length && (
        <div className="reactions">
          {m.reactions.map((r) => (
            <button key={r} className="reaction" onClick={() => api().react(m.id, m.conversationId, r)}>
              {r}
            </button>
          ))}
        </div>
      )}
      {!streaming && (
        <div className="msg-actions">
          {!!textOf(m) && <CopyButton text={textOf(m)} />}
{/* A failed reply has nothing to answer to. */}
          {m.state !== 'error' && (
          <button
            className="icon-btn sm"
            data-tip={t('添加回应')}
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                REACTIONS.map((emo) => ({
                  label: emo,
                  onClick: () => api().react(m.id, m.conversationId, emo)
                }))
              )
            }
          >
            <SmilePlus size={14} />
          </button>
          )}
          {/* The banner below a long answer already offers it. */}
          {inProjectChat && !busy && !m.blocks.some((b) => b.type === 'thread-card') && !(m.state === 'done' && suggestsThread(m, inProjectChat, last, busy)) && (
            <button className="icon-btn sm" data-tip={t('转为讨论串')} onClick={() => void api().convertToThread(m.conversationId, m.id)}>
              <Split size={14} />
            </button>
          )}
          {/* A failed or interrupted reply has its own 重试 button. */}
          {last && !busy && !m.blocks.some((b) => b.type === 'thread-card') && m.state !== 'error' && !(m.interrupted && !m.switchedTo) && (
            <button className="icon-btn sm" data-tip={t('重新生成')} onClick={() => api().regenerate(m.conversationId)}>
              <RotateCcw size={14} />
            </button>
          )}
          <MessageUsageLabel m={m} />
          {menu}
        </div>
      )}
    </div>
  )
}

/** The emoji a reply can be answered with, in one row. */
const REACTIONS = ['👍', '❤️', '🎉', '👀', '🙏', '😄']

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
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS} urlTransform={keepFileLinks}>
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

function toolIcon(kind?: string) {
  switch (kind) {
    case 'read':
      return <FileText size={14} />
    case 'edit':
    case 'delete':
    case 'move':
      return <Pencil size={14} />
    case 'search':
      return <Search size={14} />
    case 'execute':
      return <SquareTerminal size={14} />
    case 'fetch':
      return <Globe size={14} />
    default:
      return <Wrench size={14} />
  }
}

function StatusIcon({ status }: { status: ToolBlock['status'] }) {
  return (
    <span className={'status-ic ' + status}>
      {status === 'completed' ? (
        <Check size={14} />
      ) : status === 'failed' ? (
        <CircleAlert size={14} />
      ) : (
        <Loader size={14} className="spark" />
      )}
    </span>
  )
}

/** A published page; opens beside the conversation. */
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
function shortPaths(title: string): string {
  return title.replace(/`?(?:[A-Za-z]:)?(?:[\\/][^\\/\s`]+){2,}[\\/]([^\\/\s`]+)`?/g, '$1')
}

/** A search or page fetch, said as one (Codex names its search tool `mcp.codex_apps.search_service.web_run`). */
const WEB_TOOL = /(^|[.\/:_\s])(web_run|web_search|search_query|websearch|google_search|web_fetch|fetch_url|open_url)$/i
const isWeb = (title: string) => WEB_TOOL.test(title.trim())

function webTitle(title: string, a: Record<string, unknown>): string | undefined {
  const name = /[\w-]+$/.exec(title.trim())?.[0] ?? ''
  if (!isWeb(title)) return undefined
  const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)
  const q = first(a.search_query) ?? first(a.queries)
  const query = (typeof q === 'object' && q ? (q as { q?: unknown }).q : q) ?? a.query ?? a.q
  const open = first(a.open) ?? a.url
  const url = (typeof open === 'object' && open ? (open as { ref_id?: unknown; url?: unknown }).url ?? (open as { ref_id?: unknown }).ref_id : open)
  if (typeof query === 'string' && query) return t('搜索网页：{0}', query)
  if (typeof url === 'string' && url) return t('打开网页：{0}', url.replace(/^https?:\/\//, ''))
  return /fetch|open/i.test(name) ? t('打开网页') : t('搜索网页')
}

function toolTitle(tool: ToolBlock): string {
  let a: Record<string, unknown> = {}
  try {
    a = JSON.parse(tool.input ?? '{}')
  } catch {
    /* keep defaults */
  }
  if (/project_files_list$/.test(tool.title)) return t('查看项目文件')
  const web = webTitle(tool.title, a)
  if (web) return web
  if (/project_file_read$/.test(tool.title)) return t('读取项目文件 {0}', a.name ?? '')
  const m = /computer_(\w+)$/.exec(tool.title)
  if (!m) return shortPaths(tool.title)
  const c = Array.isArray(a.coordinate) ? a.coordinate : a.x !== undefined ? [a.x, a.y] : undefined
  const at = c ? t('（{0}, {1}）', c[0], c[1]) : ''
  switch (m[1]) {
    case 'request_access':
      return t('申请操控 {0}', Array.isArray(a.apps) ? a.apps.join(t('、')) : '')
    case 'list_granted_applications':
      return t('查看允许的程序')
    case 'screenshot':
      return t('查看屏幕')
    case 'zoom':
      return t('放大查看')
    case 'click':
    case 'left_click':
      return t('点击') + at
    case 'double_click':
      return t('双击') + at
    case 'triple_click':
      return t('三击') + at
    case 'right_click':
      return t('右键点击') + at
    case 'middle_click':
      return t('中键点击') + at
    case 'move':
    case 'mouse_move':
      return t('移动鼠标') + at
    case 'drag':
    case 'left_click_drag':
      return t('拖动')
    case 'scroll':
      return t('滚动') + at
    case 'type':
      return t('输入「{0}」', String(a.text ?? '').slice(0, 30))
    case 'key':
      return t('按键 {0}', a.text ?? a.keys ?? '')
    case 'hold_key':
      return t('按住 {0}', a.text ?? '')
    case 'wait':
      return t('等待')
    case 'cursor_position':
      return t('查看鼠标位置')
    case 'open_application':
      return t('打开 {0}', a.app ?? '')
    case 'read_clipboard':
      return t('读取剪贴板')
    case 'write_clipboard':
      return t('写入剪贴板')
    case 'switch_display':
      return t('切换显示器')
    case 'batch':
      return t('连续操作 {0} 步', Array.isArray(a.actions) ? a.actions.length : '')
    default:
      return tool.title
  }
}

/** What a run of tool calls did, in a few words (「运行了 2 个命令，读取了 3 个文件」). */
function toolsSummary(tools: ToolBlock[]): string {
  const parts: string[] = []
  // Web tools often come as kind 'other'; their names say what they are.
  const web = tools.filter((x) => isWeb(x.title))
  const opened = web.filter((x) => /fetch|open/i.test(x.title)).length
  const rest = tools.filter((x) => !isWeb(x.title))
  const dirs = rest.filter(isListing).length
  const count = (kinds: (string | undefined)[]) => rest.filter((x) => kinds.includes(x.toolKind) && !isListing(x)).length
  const kinds: [number, (n: number) => string][] = [
    [count(['execute']), (n) => t('运行了 {0} 个命令', n)],
    [dirs, (n) => t('查看了 {0} 个文件夹', n)],
    [count(['read']), (n) => t('读取了 {0} 个文件', n)],
    [count(['edit', 'delete', 'move']), (n) => t('修改了 {0} 个文件', n)],
    [count(['search']), (n) => t('搜索了 {0} 次', n)],
    [web.length - opened, (n) => t('搜索了 {0} 次网页', n)],
    [count(['fetch']) + opened, (n) => t('访问了 {0} 个网页', n)]
  ]
  let known = 0
  for (const [n, label] of kinds) {
    known += n
    if (n) parts.push(label(n))
  }
  if (tools.length - known) parts.push(t('用了 {0} 个工具', tools.length - known))
  const failed = tools.filter((x) => x.status === 'failed').length
  if (failed) parts.push(t('{0} 个失败', failed))
  return parts.join(t('，'))
}

/** Listing a folder is a read too, but it reads as looking at a folder. */
function isListing(tool: ToolBlock): boolean {
  return /^(列出|查看目录|list|ls\b|dir\b)|list_dir|read_dir|list_files|directory/i.test(tool.title) // i18n-ignore
}

/** A muted one-line toggle, folded by default, that opens along a thin rail (Claude's thinking line). */
function Fold({ label, live, children }: { label: string; live?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={'steps' + (open ? ' open' : '')}>
      <button className={'steps-toggle' + (live ? ' live' : '')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        <ChevronRight size={14} className="steps-chevron" />
      </button>
      {open && <div className="steps-body">{children}</div>}
    </div>
  )
}

/** One bout of thinking: 「思考了 6 秒」, folded; it opens to what the agent thought. */
function ThoughtFold({ block, live }: { block: Extract<Block, { type: 'thought' }>; live: boolean }) {
  const label = live ? t('思考中…') : block.ms == null ? t('思考过程') : block.ms >= 1000 ? t('思考了 {0} 秒', Math.round(block.ms / 1000)) : t('思考了片刻')
  return (
    <Fold label={label} live={live}>
      <div className="step-thought">
        <Markdown text={block.text.trim()} />
      </div>
    </Fold>
  )
}

/** A few tool calls stand on their own lines; a long run folds into one line that says what it did. */
const RUN_SHOWN = 4

function ToolRunView({ tools, live, ended }: { tools: ToolBlock[]; live: boolean; ended: boolean }) {
  const rows = (
    <div className="tool-run">
      {tools.map((s) => (
        <ToolRow key={s.toolId} tool={s} ended={ended} />
      ))}
    </div>
  )
  if (tools.length <= RUN_SHOWN) return rows
  return (
    <Fold label={live ? toolTitle(tools[tools.length - 1]) : toolsSummary(tools)} live={live}>
      {rows}
    </Fold>
  )
}

/**
 * One tool call; it opens to its input and output. In a reply that has ended (finished,
 * stopped, or cut off by a restart) a call never reported done no longer spins.
 */
function ToolRow({ tool: s, ended }: { tool: ToolBlock; ended: boolean }) {
  const [open, setOpen] = useState(false)
  const unfinished = ended && s.status !== 'completed' && s.status !== 'failed'
  return (
    <div className="step-tool">
      <button className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        {/computer_/.test(s.title) ? (
          <MousePointerClick size={14} />
        ) : isWeb(s.title) ? (
          <Globe size={14} />
        ) : /project_file/.test(s.title) ? (
          <FileText size={14} />
        ) : (
          toolIcon(s.toolKind)
        )}
        <span className="t" data-tip={toolTitle(s) !== s.title ? s.title : undefined}>{toolTitle(s)}</span>
        {/* Like Claude: a finished step needs no mark; running and failed ones do. */}
        {s.status !== 'completed' && !unfinished && <StatusIcon status={s.status} />}
      </button>
      {open && (
        <div className="tool-detail">
          {s.input && `${t('输入')}\n${s.input}\n\n`}
          {s.output ? `${t('输出')}\n${s.output}` : unfinished ? t('没有运行完') : s.status === 'running' ? t('运行中…') : ''}
        </div>
      )}
    </div>
  )
}

/** The agent's checklist for the turn, folded: 「清单完成 2/5」. */
function PlanFold({ entries }: { entries: Extract<Block, { type: 'plan' }>['entries'] }) {
  const done = entries.filter((e) => e.status === 'completed').length
  return (
    <Fold label={t('清单完成 {0}/{1}', done, entries.length)}>
      <Plan entries={entries} />
    </Fold>
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

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="icon-btn sm"
      data-tip={t('复制')}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
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

/** Why a reply ended early: the user stopped it, or the app quit mid-reply. */
function Stopped({ m, last }: { m: Message; last?: boolean }) {
  const resumes = useApp((s) => {
    const c = s.conversations.find((x) => x.id === m.conversationId)
    return c?.kind === 'thread' && !c.resolved
  })
  if (m.switchedTo) return <div className="small muted">{t('已中断：换成了 {0}', m.switchedTo)}</div>
  if (!m.interrupted) return <div className="small muted">{t('已停止')}</div>
  return (
    <div className="msg-error interrupted">
      <div>{resumes ? t('因应用重启中断，已自动继续') : t('因应用重启中断')}</div>
      {last && !resumes && (
        <div className="msg-error-actions">
          <button className="btn" onClick={() => void api().regenerate(m.conversationId)}>
            {t('重试')}</button>
        </div>
      )}
    </div>
  )
}

/** Plain-language wording for each recognised failure; the agent's own text stays under 「详情」. */
function errorSentence(kind: ErrorKind, name: string, how: string, raw: string): string {
  switch (kind) {
    case 'limit': {
      const wait = limitResetIn(raw)
      return wait ? t('{0} 的用量到上限了，{1}后恢复，到时点「重试」。', name, wait) : t('{0} 的用量到上限了，恢复后点「重试」。', name)
    }
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
  // Messages the app wrote itself are already in plain Chinese; only the agent's raw text gets reworded.
  const reworded = kind && raw && !isFriendly(raw) ? errorSentence(kind, name, how, raw) : null
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

/**
 * Claude's working mark: three pulsing dots and the time so far, always at the
 * very bottom of the turn, where the next words will appear. It takes the
 * place of the action row, so nothing moves when the turn ends.
 */
function WorkingMark({ since, label }: { since: number; label?: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const s = Math.max(0, Math.round((Date.now() - since) / 1000))
  return (
    <div className="working-mark" role="status">
      <span className="working-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {label && <span>{label}</span>}
      <span className="working-time">{s < 60 ? t('{0} 秒', s) : t('{0} 分 {1} 秒', Math.floor(s / 60), s % 60)}</span>
    </div>
  )
}
