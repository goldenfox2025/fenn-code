import type { Conversation, Routine } from '../../../shared/model'
import { t } from '../../../shared/i18n'
import type { Store } from '../../store/Store'
import type { ToolDef } from '../../tools/ToolServer'
import { parseScheduleArgs, scheduleText } from '../scheduleInput'
export { parseScheduleArgs, scheduleText } from '../scheduleInput'

export interface RoutineToolDeps {
  store: Store
  isUnattended: (conversationId: string) => boolean
  /** A one-line note in the conversation (e.g. 已创建定时任务…), keyed so a repeat replaces it. */
  notice: (conversationId: string, text: string, key: string) => void
  save: (r: Omit<Routine, 'id' | 'createdAt' | 'nextRunAt'> & Partial<Routine>) => Promise<Routine>
  remove: (id: string) => Promise<void>
}

/**
 * Agents can set up recurring work themselves (like Claude's routines): a
 * prompt that runs on a schedule and posts into this conversation, the
 * project chat, or a new chat each time.
 */
export function routineTools(deps: RoutineToolDeps, conv: Conversation): ToolDef[] {
  const mine = (r: Routine) =>
    r.target.conversationId === conv.id || (!!conv.projectId && r.target.projectId === conv.projectId) || r.createdBy === conv.id
  const line = (r: Routine) =>
    `${r.id.slice(0, 8)}  「${r.name}」 ${scheduleText(r.schedule)}${r.enabled ? '' : '（已暂停）'}${r.nextRunAt ? `，下次 ${new Date(r.nextRunAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`
  return [
    {
      name: 'create_routine',
      description:
        '建一个定时任务：到点时把 prompt 作为一条消息发给 agent 执行（无人值守，不能操控电脑，也不能等用户批准）。适合需要反复做的事（每天汇总、定期检查）或稍后提醒。用户能在「定时任务」页看到、暂停和删除。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '几个词的名字' },
          prompt: { type: 'string', description: '每次运行时交给 agent 的完整指令' },
          schedule: { type: 'string', enum: ['once', 'interval', 'daily', 'weekly', 'cron'] },
          at: { type: 'string', description: 'once：运行时间，ISO 8601，例如 2026-10-16T09:00:00+08:00' },
          minutes: { type: 'integer', description: 'interval：间隔分钟数（至少 5）' },
          time: { type: 'string', description: 'daily / weekly：本地时间 HH:MM' },
          weekdays: { type: 'array', items: { type: 'integer' }, description: 'weekly：星期几，0=周日 … 6=周六' },
          cron: { type: 'string', description: 'cron：五段式表达式' },
          post_to: { type: 'string', enum: ['here', 'new_chat'], description: 'here（默认）：结果发在这个对话或项目里；new_chat：每次新建一个对话' }
        },
        required: ['name', 'prompt', 'schedule']
      },
      aliases: { prompt: ['instructions', 'task', 'message'], name: ['title'] },
      run: async (a) => {
        // A routine that sets up routines could multiply without anyone watching.
        if (deps.isUnattended(conv.id))
          throw new Error('这是定时任务的无人值守运行，不能再建定时任务。需要的话，请在结果里建议用户自己建。')
        if (deps.store.routines.filter((r) => r.createdBy === conv.id).length >= 10)
          throw new Error('这个对话已经建了 10 个定时任务，不能再建。请先用 delete_routine 删掉不需要的。')
        const name = String(a.name ?? '').trim().slice(0, 60)
        const prompt = String(a.prompt ?? '').trim()
        if (!name || !prompt) throw new Error('name 和 prompt 都不能为空')
        const schedule = parseScheduleArgs(a)
        const target =
          a.post_to === 'new_chat' ? {} : conv.kind === 'project' && conv.projectId ? { projectId: conv.projectId } : { conversationId: conv.id }
        const r = await deps.save({ name, prompt, schedule, target, backendId: conv.backendId, enabled: true, createdBy: conv.id })
        deps.notice(conv.id, t('已创建定时任务「{0}」：{1}', r.name, scheduleText(r.schedule)), `routine-${r.id}`)
        return `已创建：${line(r)}`
      }
    },
    {
      name: 'list_routines',
      description: '列出和这个对话或项目有关的定时任务。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: () => deps.store.routines.filter(mine).map(line).join('\n') || '没有定时任务。'
    },
    {
      name: 'delete_routine',
      description: '删除一个定时任务（只限和这个对话或项目有关的）。id 用 list_routines 给出的前 8 位即可。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (a) => {
        const id = String(a.id ?? '').trim()
        const r = deps.store.routines.find((x) => mine(x) && (x.id === id || (id.length >= 6 && x.id.startsWith(id))))
        if (!r) throw new Error('没有这个定时任务（或它不属于这个对话）')
        await deps.remove(r.id)
        deps.notice(conv.id, t('已删除定时任务「{0}」', r.name), `routine-${r.id}`)
        return `已删除「${r.name}」。`
      }
    }
  ]
}
