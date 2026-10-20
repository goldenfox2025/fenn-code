import type { Block } from '@shared/model'

export type ToolBlock = Extract<Block, { type: 'tool' }>

/** The app's own coordination tools are plumbing; their effects show up as cards and status instead. */
export const APP_TOOL = /(^|[/_.:\s])(render_ui|publish_page|ask_decision|start_thread|start_subconversation|message_thread|list_threads|read_thread|set_thread_resolved|update_status|set_title|set_resolved|react|correct_message|memory_list|memory_read|memory_write|memory_delete|set_blocker|progress_read|progress_update)\b/

/** Tools whose result is the card itself. */
export const OUTPUT_TOOL = /(^|[/_.:\s])(attach_output|project_file_write)\b/

/** Report a specific phase only while the backend reports that work in progress. */
export function visualWork(blocks: Block[]): 'visualization' | 'page' | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type !== 'tool' || (b.status !== 'pending' && b.status !== 'running')) continue
    if (/(^|[/_.:\s])(render_ui|render_chart|publish_page)\b/.test(b.title)) return 'visualization'
    const editing = b.toolKind === 'edit' || /write|edit|create|\u4fee\u6539|\u7f16\u8f91|\u5199\u5165/i.test(b.title)
    if (editing && b.paths?.some((p) => /\.(css|html?)$/i.test(p))) return 'page'
  }
  return undefined
}

export type PlanBlock = Extract<Block, { type: 'plan' }>

/** Tool lines the reply shows in another form (app bookkeeping, a handed-over file's card). */
const hiddenTool = (b: Block) => b.type === 'tool' && (APP_TOOL.test(b.title) || (OUTPUT_TOOL.test(b.title) && b.status !== 'failed'))

/** Tool calls in a row, shown together (text with nothing in it doesn't break a run). */
export interface ToolRun {
  type: 'tools'
  tools: ToolBlock[]
}

export type Segment = Exclude<Block, ToolBlock> | ToolRun

/**
 * A turn reads like Claude's, in the order it happened: each bout of thinking
 * is one folded line (「思考了 6 秒」), tool calls in a row stand on their own
 * lines beside it, never inside it, and everything the agent writes is the
 * reply, wherever it falls. The plan comes first; thread cards and handed-over
 * files go last, under the answer.
 */
export function segmentBlocks(blocks: Block[]): Segment[] {
  const out: Segment[] = []
  const plan = blocks.find((b): b is PlanBlock => b.type === 'plan')
  if (plan) out.push(plan)
  for (const b of blocks) {
    if (b.type === 'thread-card' || b.type === 'output' || b.type === 'peer-message' || b.type === 'plan' || hiddenTool(b)) continue
    const prev = out[out.length - 1]
    if (b.type === 'tool') {
      if (prev?.type === 'tools') prev.tools.push(b)
      else out.push({ type: 'tools', tools: [b] })
      continue
    }
    if (b.type === 'text' && !b.text.trim()) continue
    // Two bouts of thinking with nothing shown between them read as one.
    if (b.type === 'thought' && prev?.type === 'thought') {
      out[out.length - 1] = { ...prev, text: `${prev.text}\n\n${b.text}`, ms: prev.ms !== undefined || b.ms !== undefined ? (prev.ms ?? 0) + (b.ms ?? 0) : undefined }
      continue
    }
    out.push(b)
  }
  return [...out, ...blocks.filter((b) => b.type === 'thread-card' || b.type === 'output' || b.type === 'peer-message')]
}
