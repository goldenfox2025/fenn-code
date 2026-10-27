import type { MemoryStore } from './MemoryStore'
import type { ToolDef } from '../tools/ToolServer'
import { obj, str } from '../core/tools/args'

/** The same memory protocol is shared by a project coordinator and a persistent Bot. */
export function memoryTools(deps: { memory: MemoryStore; wroteMemory: (conversationId: string) => void }, scope: string): ToolDef[] {
  return [
    {
      name: 'memory_list',
      description: '列出项目记忆的索引（名称、类型、一句话描述）。',
      inputSchema: obj({}, []),
      run: () => deps.memory.index(scope)
    },
    {
      name: 'memory_read',
      description: '读取一条项目记忆的全文。',
      inputSchema: obj({ name: { type: 'string' } }, ['name']),
      run: ({ name }) => {
        const m = deps.memory.read(scope, str(name, 'name'))
        if (!m) throw new Error(`没有名为 ${name} 的记忆`)
        return `${m.description}\n\n${m.body}`
      }
    },
    {
      name: 'memory_write',
      description:
        '新建或覆盖一条项目记忆（同名覆盖）。一条记忆只写一个事实。type：user（用户是谁、偏好）、feedback（用户对工作方式的要求，附原因）、project（进行中的工作、决定、约束，相对日期写成绝对日期）、reference（外部资源的位置）。',
      inputSchema: obj(
        {
          name: { type: 'string', description: '简短的 kebab-case 名称' },
          description: { type: 'string', description: '一句话说明，用于索引' },
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
          body: { type: 'string', description: '记忆内容，不超过 4000 字' }
        },
        ['name', 'body']
      ),
      aliases: { body: ['content', 'text', 'value', 'memory', 'fact'], name: ['key', 'title', 'id'], description: ['summary', 'desc'] },
      example: { name: 'user-prefers-short-replies', description: '用户希望回复简短', type: 'feedback', body: '用户说：以后回复简短一点，别用列表。' },
      run: (a, ctx) => {
        const body = str(a.body, 'body')
        const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : `note-${Date.now().toString(36)}`
        const before = deps.memory.read(scope, name)
        deps.wroteMemory(ctx.conversationId)
        const m = deps.memory.write(scope, {
          name,
          description: typeof a.description === 'string' && a.description.trim() ? a.description.trim() : body.replace(/\s+/g, ' ').slice(0, 60),
          type: typeof a.type === 'string' ? a.type : undefined,
          body
        })
        // Names are normalized ("User Prefs" = "user-prefs"), so say when an existing entry was replaced.
        return before
          ? `已更新 ${m.name}（覆盖了原来的「${before.description}」；如果那是另一件事，请换个名字重新保存它）`
          : `已保存 ${m.name}`
      }
    },
    {
      name: 'memory_delete',
      description: '删除一条已经不成立的项目记忆。',
      inputSchema: obj({ name: { type: 'string' } }, ['name']),
      run: ({ name }) => (deps.memory.remove(scope, str(name, 'name')) ? '已删除' : '没有这条记忆')
    }
  ]
}
