import { useState } from 'react'
import { Check, CircleAlert, FileText, Globe, Loader, MousePointerClick, Pencil, Search, SquareTerminal, Wrench } from 'lucide-react'
import type { ToolBlock } from '../../turn'
import { settledTitle } from '../../toolTitle'
import { t } from '../../i18n'
import { TurnDisclosure } from './TurnDisclosure'
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

function toolTitle(tool: ToolBlock, ended = false): string {
  return describeTool({ ...tool, title: settledTitle(tool.title, ended || tool.status === 'completed' || tool.status === 'failed') })
}

function describeTool(tool: ToolBlock): string {
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

/** A single quiet summary; individual inputs and outputs remain under the disclosure. */
function toolsSummary(tools: ToolBlock[]): string {
  const failed = tools.filter((x) => x.status === 'failed').length
  return [t('调用了 {0} 次工具', tools.length), failed ? t('{0} 个失败', failed) : ''].filter(Boolean).join(t('，'))
}


/** Adjacent tools share one disclosure. Prose and UI segments keep their place between runs. */
export function ToolRunView({ tools, live, ended }: { tools: ToolBlock[]; live: boolean; ended: boolean }) {
  const rows = (
    <div className="tool-run">
      {tools.map((s) => (
        <ToolRow key={s.toolId} tool={s} ended={ended} />
      ))}
    </div>
  )
  if (tools.length === 1) return rows
  const running = live ? tools.findLast((tool) => tool.status === 'running' || tool.status === 'pending') : undefined
  return (
    <TurnDisclosure label={running ? toolTitle(running) : toolsSummary(tools)} live={!!running}>
      {rows}
    </TurnDisclosure>
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
        <span className="t" data-tip={toolTitle(s, ended) !== s.title ? s.title : undefined}>{toolTitle(s, ended)}</span>
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
