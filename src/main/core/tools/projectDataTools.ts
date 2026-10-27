import { memoryTools } from '../../memory/memoryTools'
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
    ...memoryTools(deps, projectId)
  ]
}
