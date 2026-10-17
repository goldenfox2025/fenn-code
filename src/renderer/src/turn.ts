import type { Block } from '@shared/model'

export type ToolBlock = Extract<Block, { type: 'tool' }>

/** The app's own coordination tools are plumbing; their effects show up as cards and status instead. */
export const APP_TOOL = /(^|[/_.:\s])(publish_page|ask_decision|start_thread|start_subconversation|message_thread|list_threads|read_thread|set_thread_resolved|update_status|set_title|set_resolved|react|correct_message|memory_list|memory_read|memory_write|memory_delete|set_blocker|progress_read|progress_update)\b/

/** Tools whose result is the card itself. */
export const OUTPUT_TOOL = /(^|[/_.:\s])(attach_output|project_file_write)\b/

export type PlanBlock = Extract<Block, { type: 'plan' }>
export type StepBlock = ToolBlock | Extract<Block, { type: 'thought' }> | PlanBlock | Extract<Block, { type: 'text' }>

/** Tool lines the reply shows in another form (app bookkeeping, a handed-over file's card). */
const hiddenTool = (b: Block) => b.type === 'tool' && (APP_TOOL.test(b.title) || (OUTPUT_TOOL.test(b.title) && b.status !== 'failed'))

/**
 * A turn reads like Claude's: one quiet "steps" line, then the answer. All
 * thinking and tool calls fold into that one line, and so does any text the
 * agent wrote before a tool call (「我先看看…」), since only text after the last
 * tool call is the answer. Thinking alone never takes text in: an agent that
 * thinks again after answering keeps its answer on screen. The plan joins the steps; thread cards and handed-over files
 * go last, under the answer.
 */
export function groupBlocks(blocks: Block[]): (Block | StepBlock[])[] {
  const out: (Block | StepBlock[])[] = []
  const plan = blocks.find((b): b is PlanBlock => b.type === 'plan')
  const cards = blocks.filter((b) => b.type === 'thread-card' || b.type === 'output' || b.type === 'peer-message')
  let lastStep = -1
  blocks.forEach((b, i) => {
    if (b.type === 'tool' && !hiddenTool(b)) lastStep = i
  })
  let steps: StepBlock[] | undefined
  blocks.forEach((b, i) => {
    if (b.type === 'thread-card' || b.type === 'output' || b.type === 'peer-message' || b.type === 'plan' || hiddenTool(b)) return
    const isStep = b.type === 'tool' || b.type === 'thought' || (b.type === 'text' && i < lastStep)
    if (!isStep) return void out.push(b)
    if (b.type === 'text' && !b.text.trim()) return
    if (!steps) out.push((steps = []))
    steps.push(b as StepBlock)
  })
  if (plan) {
    if (steps) steps.unshift(plan)
    else out.unshift([plan])
  }
  return [...out, ...cards]
}

