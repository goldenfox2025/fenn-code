import type { Conversation, ProgressItem, ProgressPatch } from '../../../shared/model'
import type { Store } from '../../store/Store'
import type { ToolDef } from '../../tools/ToolServer'
import { progressText, resolveItem, statusOf } from '../progress'
import { obj } from './args'

export interface ProgressToolDeps {
  store: Store
  /** Adds or changes one item on a project's progress board (AppCore owns projects). */
  progress?: (projectId: string, patch: ProgressPatch, by: 'agent' | 'app') => ProgressItem
}

/** The project's progress board: read it, and move milestones and tasks along. */
export function progressTools(deps: ProgressToolDeps, projectId: string, conv: Conversation): ToolDef[] {
  const linkHere = conv.kind === 'thread' || conv.kind === 'chat' ? [conv.id] : []
  return [
    {
      name: 'progress_read',
      description: '读取项目进度表：里程碑和其下的任务，每项有状态（✓ 完成、✱ 进行中、! 受阻、○ 未开始）、id 和截止日期。',
      inputSchema: obj({}, []),
      run: () => progressText(deps.store.project(projectId)?.progress ?? [])
    },
    {
      name: 'progress_update',
      description:
        '更新项目进度表里的一项，或新增一项。里程碑是大目标，任务是里程碑下的具体工作。开始、完成、受阻时都更新状态。改已有的项传 item（id 或标题）；新增里程碑只传 title；在里程碑下新增任务再传 milestone（id 或标题）。本讨论串会自动关联到这一项。',
      inputSchema: obj(
        {
          item: { type: 'string', description: '要修改的项的 id 或标题；新增时不填' },
          milestone: { type: 'string', description: '新增任务时，所属里程碑的 id 或标题' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] },
          due: { type: 'string', description: '截止日期 YYYY-MM-DD，可选' },
          note: { type: 'string', description: '一句话备注，可选' }
        },
        []
      ),
      aliases: { item: ['id', 'item_id', 'name'], milestone: ['parent', 'parent_id', 'milestone_id'], status: ['state'], due: ['due_date', 'deadline'] },
      example: { milestone: '上线第一版', title: '写安装说明', status: 'doing' },
      run: ({ item, milestone, title, status, due, note }) => {
        if (!deps.progress) throw new Error('进度表不可用')
        const items = deps.store.project(projectId)?.progress ?? []
        const ref = typeof item === 'string' ? item : ''
        const parent = typeof milestone === 'string' && milestone ? resolveItem(items, milestone) : undefined
        // A new item whose title is already there beside it updates that one instead of adding a twin.
        const same = (list: ProgressItem[] = []) =>
          typeof title === 'string' ? list.find((x) => x.title.trim().toLowerCase() === title.trim().toLowerCase()) : undefined
        const existing = ref ? resolveItem(items, ref) : same(parent ? parent.children : items)
        if (ref && !existing && !title) throw new Error(`进度表里没有「${ref}」。先用 progress_read 看看现有的项。`)
        if (milestone && !parent && !existing) throw new Error(`进度表里没有里程碑「${milestone}」。`)
        const st = status === undefined ? undefined : statusOf(status)
        if (status !== undefined && !st) throw new Error('status 只能是 todo / doing / blocked / done')
        const saved = deps.progress(projectId, {
          id: existing?.id,
          parentId: existing ? undefined : parent?.id,
          title: typeof title === 'string' ? title : existing ? undefined : ref,
          status: st,
          due: typeof due === 'string' ? due : undefined,
          note: typeof note === 'string' ? note : undefined,
          link: linkHere,
          suggested: false
        }, 'agent')
        return `已保存：${saved.title} [id:${saved.id}]`
      }
    }
  ]
}
