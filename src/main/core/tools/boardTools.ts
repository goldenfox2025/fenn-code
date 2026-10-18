import { randomUUID } from 'node:crypto'
import type { BoardTone, BoardWidget, BoardWidgetBody, Conversation, Routine } from '../../../shared/model'
import { t } from '../../../shared/i18n'
import type { Store } from '../../store/Store'
import type { ToolDef } from '../../tools/ToolServer'
import { parseScheduleArgs, scheduleText } from './routineTools'

export interface BoardToolDeps {
  store: Store
  isUnattended: (conversationId: string) => boolean
  notice: (conversationId: string, text: string, key: string) => void
  put: (w: BoardWidget) => void
  remove: (id: string) => Promise<void>
  saveRoutine: (r: Omit<Routine, 'id' | 'createdAt' | 'nextRunAt'> & Partial<Routine>) => Promise<Routine>
  deleteRoutine: (id: string) => Promise<void>
}

/** Cards one agent may make, so a loop can't fill the home page. */
const MAX_CARDS = 20

const str = (v: unknown, max: number) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '')
const tone = (v: unknown): BoardTone | undefined => (v === 'good' || v === 'warn' || v === 'bad' ? v : undefined)
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : [])
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** A card's data as the agent sent it, checked and cut to size; throws a message the agent can act on. */
export function boardBody(kind: unknown, raw: unknown): BoardWidgetBody {
  const d = obj(raw)
  switch (kind) {
    case 'stat': {
      const items = list(d.items, 8).map((i) => obj(i)).map((i) => ({ label: str(i.label, 40), value: str(i.value, 40), note: str(i.note, 80) || undefined, tone: tone(i.tone) }))
      if (!items.length || items.some((i) => !i.label || !i.value)) throw new Error('stat 需要 data.items：[{label, value, note?, tone?}]，label 和 value 都不能为空')
      return { kind, items }
    }
    case 'list': {
      const items = list(d.items, 30).map((i) => (typeof i === 'string' ? { text: i } : obj(i))).map((i) => ({ text: str(i.text, 200), done: i.done === true ? true : undefined, note: str(i.note, 80) || undefined, tone: tone(i.tone) }))
      if (!items.length || items.some((i) => !i.text)) throw new Error('list 需要 data.items：[{text, done?, note?, tone?}]')
      return { kind, items }
    }
    case 'table': {
      const columns = list(d.columns, 8).map((c) => str(c, 40))
      const rows = list(d.rows, 50).map((r) => list(r, columns.length).map((c) => str(c, 120)))
      if (!columns.length || !rows.length) throw new Error('table 需要 data.columns（列名）和 data.rows（每行一个数组）')
      return { kind, columns, rows }
    }
    case 'chart': {
      const labels = list(d.labels, 60).map((l) => str(l, 24))
      const series = list(d.series, 4)
        .map((s) => obj(s))
        .map((s) => ({ name: str(s.name, 40), values: list(s.values, labels.length).map((v) => Number(v)) }))
      if (!labels.length || !series.length || series.some((s) => s.values.length !== labels.length || s.values.some((v) => !Number.isFinite(v))))
        throw new Error('chart 需要 data.labels 和 data.series：[{name, values}]，每组 values 的个数和 labels 一样，都是数字')
      return { kind, style: d.style === 'line' ? 'line' : 'bar', labels, series, unit: str(d.unit, 12) || undefined }
    }
    case 'markdown': {
      const text = str(d.text, 20_000)
      if (!text) throw new Error('markdown 需要 data.text')
      return { kind, text }
    }
    case 'html': {
      const html = typeof d.html === 'string' ? d.html.slice(0, 200_000) : ''
      if (!html.trim()) throw new Error('html 需要 data.html（完整的自包含页面）')
      const height = Number(d.height)
      return { kind, html, height: Number.isFinite(height) ? Math.max(120, Math.min(600, Math.round(height))) : undefined }
    }
    default:
      throw new Error('kind 只能是 stat、list、table、chart、markdown 或 html')
  }
}

/**
 * Cards on the home board, from any chat or project: the agent sends data,
 * Fenn Code draws it. A card can be refreshed by a routine, whose every run
 * replaces the card's data (and only its latest run's chat is kept).
 */
export function boardTools(deps: BoardToolDeps, conv: Conversation): ToolDef[] {
  const line = (w: BoardWidget) => {
    const r = w.routineId && deps.store.routines.find((x) => x.id === w.routineId)
    return `${w.id.slice(0, 8)}  「${w.title}」 ${w.body.kind}${r ? `，定时刷新：${scheduleText(r.schedule)}` : ''}`
  }
  const find = (id: string) => deps.store.boardWidgets.find((w) => w.id === id || (id.length >= 6 && w.id.startsWith(id)))
  return [
    {
      name: 'home_board',
      description:
        '首页看板的卡片（用户说「放到首页」「改看板」时用）。list 列出；put 新建，给 id 则整张替换；remove 删除。只给数据，应用来画；html 仅在确需自定义界面时用。要定时刷新就给 refresh。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'put', 'remove'] },
          id: { type: 'string' },
          title: { type: 'string' },
          size: { type: 'string', enum: ['wide', 'half'] },
          kind: { type: 'string', enum: ['stat', 'list', 'table', 'chart', 'markdown', 'html'] },
          data: {
            type: 'object',
            description: 'stat {items:[{label,value,note?,tone?}]}；list {items:[{text,done?,note?,tone?}]}；table {columns,rows}；chart {style,labels,series:[{name,values}],unit?}；markdown {text}；html {html,height?}；tone=good|warn|bad'
          },
          refresh: {
            type: 'object',
            description: '{prompt（每次怎么取数据）, schedule: interval|daily|weekly|cron, minutes?, time?, weekdays?, cron?}；{off:true} 停止'
          }
        },
        required: ['action']
      },
      aliases: { data: ['content', 'body'], title: ['name'] },
      example: { action: 'put', title: '服务器状态', kind: 'stat', data: { items: [{ label: '在线', value: '3 台', tone: 'good' }] } },
      run: async (a) => {
        const unattended = deps.isUnattended(conv.id)
        if (a.action === 'list') return deps.store.boardWidgets.map(line).join('\n') || '首页看板上还没有 agent 做的卡片。'
        const id = str(a.id, 64)
        if (a.action === 'remove') {
          if (unattended) throw new Error('定时任务的无人值守运行不能删除卡片。')
          const w = id && find(id)
          if (!w) throw new Error('没有这张卡片，用 action=list 看看有哪些')
          await deps.remove(w.id)
          deps.notice(conv.id, t('已从首页删除卡片「{0}」', w.title), `board-${w.id}`)
          return `已删除「${w.title}」。`
        }
        if (a.action !== 'put') throw new Error('action 只能是 list、put 或 remove')
        const prev = id ? find(id) : undefined
        if (id && !prev) throw new Error('没有这张卡片；新建卡片时不要给 id')
        // A refresh run only updates the card it refreshes.
        if (unattended && (!prev || !conv.routineId || prev.routineId !== conv.routineId)) throw new Error('定时任务的无人值守运行只能更新它负责刷新的那张卡片。')
        if (!prev && deps.store.boardWidgets.filter((w) => w.createdBy === conv.id).length >= MAX_CARDS)
          throw new Error(`这个对话已经做了 ${MAX_CARDS} 张卡片，不能再加。请先删掉不需要的。`)
        const title = str(a.title, 60) || prev?.title
        if (!title) throw new Error('新卡片需要 title')
        const body = a.kind === undefined && a.data === undefined && prev ? prev.body : boardBody(a.kind ?? prev?.body.kind, a.data)
        const now = Date.now()
        const w: BoardWidget = {
          id: prev?.id ?? randomUUID(),
          title,
          size: a.size === 'half' || a.size === 'wide' ? a.size : (prev?.size ?? 'wide'),
          body,
          createdBy: prev?.createdBy ?? conv.id,
          routineId: prev?.routineId,
          createdAt: prev?.createdAt ?? now,
          updatedAt: now
        }
        let refreshed = ''
        const refresh = a.refresh === undefined ? undefined : obj(a.refresh)
        if (refresh && !unattended) {
          if (refresh.off === true) {
            if (w.routineId) await deps.deleteRoutine(w.routineId)
            w.routineId = undefined
            refreshed = '，已停止定时刷新'
          } else {
            const prompt = str(refresh.prompt ?? refresh.instructions, 4000)
            if (!prompt) throw new Error('refresh 需要 prompt：每次运行时怎么取数据')
            const schedule = parseScheduleArgs(refresh)
            const r = await deps.saveRoutine({
              ...(w.routineId ? { id: w.routineId } : {}),
              name: t('看板 · {0}', title),
              prompt: `${prompt}\n\n做完后调用 home_board：action=put，id=${w.id}，把这张卡片整个换成最新的数据（kind 和 data 都给出）。只更新这张卡片，不要做别的。`,
              schedule,
              target: {},
              backendId: conv.backendId,
              enabled: true,
              createdBy: conv.id,
              widgetId: w.id
            })
            w.routineId = r.id
            refreshed = `，定时刷新：${scheduleText(r.schedule)}`
          }
        }
        deps.put(w)
        if (!unattended) deps.notice(conv.id, prev ? t('已更新首页卡片「{0}」', title) : t('已把「{0}」放到首页', title), `board-${w.id}`)
        return `${prev ? '已更新' : '已放到首页'}：${w.id.slice(0, 8)}「${title}」${refreshed}`
      }
    }
  ]
}
