/**
 * Files the user adds to a project (specs, notes, data, images), like the
 * knowledge files of a Claude project. Stored in the app's data folder; every
 * agent in the project sees the list and can read them through app tools,
 * whatever backend it runs on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export interface ProjectFile {
  name: string
  size: number
  updatedAt: number
  path: string
}

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
const MAX_FILE = 30_000_000

export class ProjectFiles {
  constructor(private readonly root: string) {}

  directory(projectId: string): string {
    const d = join(this.root, 'projects', projectId.replace(/[^a-zA-Z0-9-]/g, ''), 'files')
    mkdirSync(d, { recursive: true })
    return d
  }

  list(projectId: string): ProjectFile[] {
    const d = this.directory(projectId)
    return readdirSync(d)
      .map((name) => {
        const st = statSync(join(d, name))
        return st.isFile() ? { name, size: st.size, updatedAt: st.mtimeMs, path: join(d, name) } : undefined
      })
      .filter((f): f is ProjectFile => !!f)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  add(projectId: string, name: string, base64: string): ProjectFile {
    const clean = safeName(name)
    const buf = Buffer.from(base64, 'base64')
    if (buf.length > MAX_FILE) throw new Error(`${clean} 太大（上限 30 MB）`)
    const f = join(this.directory(projectId), clean)
    writeFileSync(f, buf)
    return this.list(projectId).find((x) => x.name === clean)!
  }

  remove(projectId: string, name: string): void {
    const f = join(this.directory(projectId), safeName(name))
    if (existsSync(f)) rmSync(f)
  }

  /** Text content (paged), or an image; binary files can only be referenced by path. */
  read(
    projectId: string,
    name: string,
    offset = 0,
    limit = 60_000
  ): { kind: 'text'; text: string; total: number } | { kind: 'image'; data: string; mimeType: string } {
    const f = join(this.directory(projectId), safeName(name))
    if (!existsSync(f)) throw new Error(`没有名为 ${name} 的项目文件`)
    const mime = IMAGE[extname(f).toLowerCase()]
    const buf = readFileSync(f)
    if (mime) return { kind: 'image', data: buf.toString('base64'), mimeType: mime }
    if (buf.subarray(0, 4000).includes(0)) throw new Error(`${name} 是二进制文件，无法作为文本读取。文件路径：${f}`)
    const text = buf.toString('utf8')
    return { kind: 'text', text: text.slice(offset, offset + limit), total: text.length }
  }

  /** The list every project agent gets in its context. */
  index(projectId: string): string {
    const files = this.list(projectId)
    if (!files.length) return ''
    return files.map((f) => `- ${f.name}（${humanSize(f.size)}）`).join('\n')
  }
}

function safeName(name: string): string {
  const n = basename(name.replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim()
  if (!n || n === '.' || n === '..') throw new Error('文件名无效')
  return n.slice(0, 180)
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
