import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MessageUsageLabel } from './Usage'
import { OutputCard } from './Outputs'
import {
  AppWindow,
  Check,
  ChevronDown,
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
  Sparkles,
  SquareTerminal,
  Wrench,
  CornerUpLeft,
  Split,
  PackageOpen
} from 'lucide-react'
import { currentBlocker, type Block, type Conversation, type Message } from '@shared/model'
import { planHeadline } from './PlanLine'
import { api, useApp } from '../store'
import { dayLabel, STATUS_LABEL, textOf, threadState } from '../util'
import { useMenu } from './Menu'
import { AttachmentChip } from './Composer'
import { t } from '../i18n'
import { LoginButton, TerminalLoginButton } from './Dialogs'
import { classifyError, isFriendly, type ErrorKind } from '@shared/errors'

type ToolBlock = Extract<Block, { type: 'tool' }>

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
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
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
    return <div className="msg msg-system">{textOf(m)}</div>
  }
  if (m.role === 'user') return <UserMessage m={m} busy={busy} />
  return <AssistantMessage m={m} last={last} busy={busy} />
})

/** "已发送到讨论串" under a project-chat message the coordinator passed on; opens that thread. */
function ForwardedNote({ m }: { m: Message }) {
  const thread = useApp((s) => s.conversations.find((c) => c.id === m.forwardedTo))
  const navigate = useApp((s) => s.navigate)
  if (!thread?.projectId) return null
  return (
    <button className="forwarded" onClick={() => navigate({ view: 'project', projectId: thread.projectId!, threadId: thread.id })}>
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
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') setEditing(null)
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
      {text && <div className="bubble">{text}</div>}
      {m.forwardedTo && <ForwardedNote m={m} />}
      {/* The agent's emoji answer to this message (e.g. 👍 for thanks). */}
      {!!m.reactions?.length && (
        <div className="reactions on-user">
          {m.reactions.map((r) => (
            <span key={r} className="reaction" title={t('Agent 的回应')}>
              {r}
            </span>
          ))}
        </div>
      )}
      <div className="msg-actions">
        {m.variant && m.variant.count > 1 && <VersionSwitch m={m} busy={busy} />}
        <CopyButton text={text} />
        {!busy && (
          <button className="icon-btn sm" title={t('编辑')} onClick={() => setEditing(text)}>
            <Pencil size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

/** ‹ 2 / 3 ›: the versions of an edited or regenerated turn, as in Claude. */
function VersionSwitch({ m, busy }: { m: Message; busy?: boolean }) {
  const v = m.variant!
  const go = (i: number) => void api().switchVariant(m.conversationId, v.group, i)
  return (
    <span className="version-switch">
      <button className="icon-btn sm" title={t('上一个版本')} disabled={busy || v.index === 0} onClick={() => go(v.index - 1)}>
        <ChevronLeft size={14} />
      </button>
      <span className="small muted">
        {v.index + 1} / {v.count}
      </span>
      <button className="icon-btn sm" title={t('下一个版本')} disabled={busy || v.index === v.count - 1} onClick={() => go(v.index + 1)}>
        <ChevronRight size={14} />
      </button>
    </span>
  )
}

function AssistantMessage({ m, last, busy }: { m: Message; last?: boolean; busy?: boolean }) {
  const streaming = m.state === 'streaming'
  const groups = groupBlocks(m.blocks)
  const lastText = [...m.blocks].reverse().find((b) => b.type === 'text')
  const [menu, openMenu] = useMenu()
  const inProjectChat = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.kind === 'project')
  if (!streaming && m.state === 'done' && groups.length === 0 && !m.reactions?.length) return null

  return (
    <div className="msg msg-assistant">
      {groups.map((g, i) => {
        if (Array.isArray(g)) return <Steps key={i} steps={g} live={streaming && i === groups.length - 1} />
        switch (g.type) {
          case 'text':
            return <Markdown key={i} text={g.text} cursor={streaming && g === lastText} />
          case 'notice':
            return (
              <div key={i} className={'notice ' + g.level}>
                {g.text}
              </div>
            )
          case 'thread-card':
            return <ThreadCard key={i} threadId={g.threadId} />
          case 'artifact':
            return <PageCard key={i} id={g.artifactId} title={g.title} version={g.version} />
          case 'output':
            return <OutputCard key={i} o={g} />
          case 'decision':
            return <DecisionCard key={i} m={m} index={m.blocks.indexOf(g)} d={g} />
          default:
            return null
        }
      })}
      {streaming && !m.blocks.some((b) => b.type === 'text' && b.text) && !m.blocks.some((b) => b.type === 'thought' || (b.type === 'tool' && !APP_TOOL.test(b.title))) && (
        <div className="thinking-row">
          <Sparkles size={16} className="spark" />
          {m.blocks.length ? t('正在处理…') : t('正在思考…')}
        </div>
      )}
      {m.editedAt && (
        <div className="edited-mark small muted" title={new Date(m.editedAt).toLocaleString()}>
          {t('已编辑')}
        </div>
      )}
      {m.state === 'error' && <ErrorBar m={m} />}
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
          <CopyButton text={textOf(m)} />
          <button
            className="icon-btn sm"
            title={t('添加回应')}
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                ['👍', '❤️', '🎉', '👀', '🙏', '😄'].map((emo) => ({
                  label: emo,
                  onClick: () => api().react(m.id, m.conversationId, emo)
                }))
              )
            }
          >
            <SmilePlus size={14} />
          </button>
          {inProjectChat && !busy && !m.blocks.some((b) => b.type === 'thread-card') && (
            <button className="icon-btn sm" title={t('转为讨论串')} onClick={() => void api().convertToThread(m.conversationId, m.id)}>
              <Split size={14} />
            </button>
          )}
          {last && !busy && !m.blocks.some((b) => b.type === 'thread-card') && (
            <button className="icon-btn sm" title={t('重新生成')} onClick={() => api().regenerate(m.conversationId)}>
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

/** The app's own coordination tools are plumbing; their effects show up as cards and status instead. */
const APP_TOOL = /(^|[/_.:\s])(publish_page|ask_decision|start_thread|message_thread|list_threads|read_thread|set_thread_resolved|update_status|set_title|set_resolved|react|correct_message|memory_list|memory_read|memory_write|memory_delete|set_blocker|progress_read|progress_update)\b/

/** Tools whose result is the card itself. */
const OUTPUT_TOOL = /(^|[/_.:\s])(attach_output|project_file_write)\b/

type PlanBlock = Extract<Block, { type: 'plan' }>
type StepBlock = ToolBlock | Extract<Block, { type: 'thought' }> | PlanBlock

/**
 * Thinking and tool calls in a row fold into one quiet "steps" line, like
 * Claude. The plan (one block, updated in place) joins the first of those
 * lines; thread cards and handed-over files go last, under the reply text.
 */
function groupBlocks(blocks: Block[]): (Block | StepBlock[])[] {
  const out: (Block | StepBlock[])[] = []
  const plan = blocks.find((b): b is PlanBlock => b.type === 'plan')
  const cards = blocks.filter((b) => b.type === 'thread-card' || b.type === 'output')
  for (const b of blocks) {
    if (b.type === 'thread-card' || b.type === 'output' || b.type === 'plan') continue
    // A handed-over file shows as its card; only a failed hand-over keeps its tool line.
    if (b.type === 'tool' && (APP_TOOL.test(b.title) || (OUTPUT_TOOL.test(b.title) && b.status !== 'failed'))) continue
    const last = out[out.length - 1]
    if (b.type === 'tool' || b.type === 'thought') {
      if (Array.isArray(last)) last.push(b)
      else out.push([b])
    } else out.push(b)
  }
  if (plan) {
    const first = out.find((g): g is StepBlock[] => Array.isArray(g))
    if (first) first.unshift(plan)
    else out.unshift([plan])
  }
  return [...out, ...cards]
}

const Markdown = memo(function Markdown({ text, cursor }: { text: string; cursor?: boolean }) {
  return (
    <div className={'md' + (cursor ? ' cursor-host' : '')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
        }}
      >
        {text}
      </ReactMarkdown>
      {cursor && <span className="cursor" />}
    </div>
  )
})

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
    <button className={'page-card' + (open ? ' open' : '')} onClick={() => useApp.getState().set({ page: { id, version } })}>
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
function toolTitle(tool: ToolBlock): string {
  let a: Record<string, unknown> = {}
  try {
    a = JSON.parse(tool.input ?? '{}')
  } catch {
    /* keep defaults */
  }
  if (/project_files_list$/.test(tool.title)) return t('查看项目文件')
  if (/project_file_read$/.test(tool.title)) return t('读取项目文件 {0}', a.name ?? '')
  const m = /computer_(\w+)$/.exec(tool.title)
  if (!m) return tool.title
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

/** One line that says what the agent did (「思考了 4 秒，运行了 2 个命令」). */
function stepsSummary(steps: StepBlock[]): string {
  const parts: string[] = []
  const thoughts = steps.filter((s) => s.type === 'thought')
  if (thoughts.length) {
    const ms = thoughts.reduce((n, s) => n + (s.ms ?? 0), 0)
    const timed = thoughts.some((s) => s.ms != null)
    parts.push(!timed ? t('思考过程') : ms >= 1000 ? t('思考了 {0} 秒', Math.round(ms / 1000)) : t('思考了片刻'))
  }
  const plan = steps.find((s): s is PlanBlock => s.type === 'plan')
  if (plan) {
    const done = plan.entries.filter((e) => e.status === 'completed').length
    parts.push(t('清单完成 {0}/{1}', done, plan.entries.length))
  }
  const tools = steps.filter((s): s is ToolBlock => s.type === 'tool')
  const dirs = tools.filter(isListing).length
  const count = (kinds: (string | undefined)[]) => tools.filter((x) => kinds.includes(x.toolKind) && !isListing(x)).length
  const kinds: [number, (n: number) => string][] = [
    [count(['execute']), (n) => t('运行了 {0} 个命令', n)],
    [dirs, (n) => t('查看了 {0} 个文件夹', n)],
    [count(['read']), (n) => t('读取了 {0} 个文件', n)],
    [count(['edit', 'delete', 'move']), (n) => t('修改了 {0} 个文件', n)],
    [count(['search']), (n) => t('搜索了 {0} 次', n)],
    [count(['fetch']), (n) => t('访问了 {0} 个网页', n)]
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

/** What the agent is doing right now, for the live line. */
function liveLabel(steps: StepBlock[]): string {
  const last = steps[steps.length - 1]
  if (last.type === 'thought') return t('思考中…')
  if (last.type === 'plan') return last.entries.find((e) => e.status === 'in_progress')?.content ?? t('正在处理…')
  return toolTitle(last)
}

/**
 * Thinking and tool calls, like Claude: a muted one-line toggle, folded by
 * default, that opens into the steps along a thin rail. Each tool opens to
 * its input and output.
 */
function Steps({ steps, live }: { steps: StepBlock[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const [tool, setTool] = useState<string | null>(null)
  return (
    <div className={'steps' + (open ? ' open' : '')}>
      <button className={'steps-toggle' + (live ? ' live' : '')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{live ? liveLabel(steps) : stepsSummary(steps)}</span>
        <ChevronRight size={14} className="steps-chevron" />
      </button>
      {open && (
        <div className="steps-body">
          {steps.map((s, i) =>
            s.type === 'plan' ? (
              <Plan key={i} entries={s.entries} />
            ) : s.type === 'thought' ? (
              <div key={i} className="step-thought">
                {s.text}
              </div>
            ) : (
              <div key={s.toolId} className="step-tool">
                <button className="tool-row" onClick={() => setTool(tool === s.toolId ? null : s.toolId)}>
                  {/computer_/.test(s.title) ? (
                    <MousePointerClick size={14} />
                  ) : /project_file/.test(s.title) ? (
                    <FileText size={14} />
                  ) : (
                    toolIcon(s.toolKind)
                  )}
                  <span className="t">{toolTitle(s)}</span>
                  <StatusIcon status={s.status} />
                </button>
                {tool === s.toolId && (
                  <div className="tool-detail">
                    {s.input && `${t('输入')}\n${s.input}\n\n`}
                    {s.output ? `${t('输出')}\n${s.output}` : s.status === 'running' ? t('运行中…') : ''}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
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
  const st = threadState(thread)
  const headline = planHeadline(thread)
  return (
    <button
      className="thread-card"
      onClick={() => navigate({ view: 'project', projectId: thread.projectId!, threadId: thread.id })}
    >
      <MessagesSquare size={15} className="muted" />
      <span className="t">{thread.title}</span>
      {!!thread.messageCount && <span className="small muted">{t('{0} 条回复', thread.messageCount)}</span>}
      {outputs > 0 && (
        <span className="thread-outputs" title={t('{0} 份成果', outputs)}>
          <PackageOpen size={12} />
          {outputs}
        </span>
      )}
      <span className={'status-chip ' + st}>
        {st === 'working' && <Loader size={11} className="spark" />}
        {thread.resolved ? t('已解决') : STATUS_LABEL[st]}
      </span>
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
      title={t('复制')}
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
function errorSentence(kind: ErrorKind, name: string, how: string): string {
  switch (kind) {
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
export function ErrorBar({ m }: { m: Message }) {
  const backendId = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.backendId)
  const backend = useApp((s) => s.backends.find((b) => b.id === backendId))
  const raw = m.error ?? ''
  const kind = classifyError(raw)
  const name = backend?.name ?? 'Agent'
  const secret = backend?.settings.find((x) => x.secret)
  const canLogin = !!(backend?.signIn || backend?.terminalLogin)
  const how = canLogin ? t('点下方「登录」，完成后点「重试」。') : secret ? t('请在设置里填写「{0}」，然后重试。', secret.label) : t('请按它的说明登录后重试。')
  // Messages the app wrote itself are already in plain Chinese; only the agent's raw text gets reworded.
  const reworded = kind && raw && !isFriendly(raw) ? errorSentence(kind, name, how) : null
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
        <button className="btn" onClick={() => void api().regenerate(m.conversationId)}>
          {t('重试')}</button>
      </div>
    </div>
  )
}

/**
 * When the coordinator answered a substantial request inline instead of
 * starting a thread (weaker models often do), offer to move it into one.
 */
function ThreadSuggestion({ m, last, busy }: { m: Message; last?: boolean; busy?: boolean }) {
  const inProjectChat = useApp((s) => s.conversations.find((c) => c.id === m.conversationId)?.kind === 'project')
  const [sent, setSent] = useState(false)
  if (!inProjectChat || !last || busy || sent) return null
  if (m.blocks.some((b) => b.type === 'thread-card') || textOf(m).length < 400) return null
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
