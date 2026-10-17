import type { ProjectFiles } from '../ProjectFiles'
import type { ProjectMemory } from '../ProjectMemory'
import { ToolContent, type ToolDef } from '../../tools/ToolServer'
import { obj, str } from './args'

export interface ProjectDataToolDeps {
  files: ProjectFiles
  memory: ProjectMemory
  /** Shows a file the agent wrote as a card under its reply. */
  attachOutput: (conversationId: string, o: { kind: 'file'; title: string; path: string; size: number }) => void
  /** The agent saved a memory this turn (so the app doesn't save the same fact again). */
  wroteMemory: (conversationId: string) => void
}

/** The project's files and its memory, shared by every agent in the project. */
export function projectDataTools(deps: ProjectDataToolDeps, projectId: string, conversationId: string): ToolDef[] {
  return [
    {
      name: 'project_files_list',
      description: '列出用户放进这个项目的文件（名称、大小、本机路径）。',
      inputSchema: obj({}, []),
      run: () => deps.files.list(projectId).map((f) => ({ name: f.name, size: f.size, path: f.path }))
    },
    {
      name: 'project_file_read',
      description: '读取一个项目文件。文本文件按字符分页返回（offset 从 0 开始），图片直接返回图像。',
      inputSchema: obj({ name: { type: 'string' }, offset: { type: 'integer' } }, ['name']),
      run: ({ name, offset }) => {
        const r = deps.files.read(projectId, str(name, 'name'), Number(offset) || 0)
        if (r.kind === 'image') return new ToolContent([{ type: 'image', data: r.data, mimeType: r.mimeType }])
        const start = Number(offset) || 0
        const more = start + r.text.length < r.total ? `\n\n（共 ${r.total} 字，下一页 offset=${start + r.text.length}）` : ''
        return r.text + more
      }
    },
    {
      name: 'project_file_write',
      description:
        '把一份成果写进项目文件（报告、表格、数据、代码片段），项目里所有 agent 都能读到，同时作为附件卡片显示在你这条回复下面。已有同名文件会被覆盖。二进制内容用 encoding: "base64"。',
      inputSchema: obj(
        {
          name: { type: 'string', description: '文件名，例如 竞品定价.md' },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: '默认 utf8' }
        },
        ['name', 'content']
      ),
      aliases: { name: ['filename', 'file', 'path'], content: ['text', 'body', 'data'] },
      run: ({ name, content, encoding }) => {
        const text = String(content ?? '')
        const b64 = encoding === 'base64' ? text : Buffer.from(text, 'utf8').toString('base64')
        const f = deps.files.add(projectId, str(name, 'name'), b64)
        deps.attachOutput(conversationId, { kind: 'file', title: f.name, path: f.path, size: f.size })
        return { name: f.name, size: f.size, path: f.path }
      }
    },
    {
      name: 'memory_list',
      description: '列出项目记忆的索引（名称、类型、一句话描述）。',
      inputSchema: obj({}, []),
      run: () => deps.memory.index(projectId)
    },
    {
      name: 'memory_read',
      description: '读取一条项目记忆的全文。',
      inputSchema: obj({ name: { type: 'string' } }, ['name']),
      run: ({ name }) => {
        const m = deps.memory.read(projectId, str(name, 'name'))
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
        const before = deps.memory.read(projectId, name)
        deps.wroteMemory(ctx.conversationId)
        const m = deps.memory.write(projectId, {
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
      run: ({ name }) => (deps.memory.remove(projectId, str(name, 'name')) ? '已删除' : '没有这条记忆')
    }
  ]
}
