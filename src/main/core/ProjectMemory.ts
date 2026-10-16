/**
 * Durable project memory: one Markdown file per fact, under the project's
 * folder in the app's data directory. Every agent working in the project sees
 * the index and can read and write entries, so what the project has learned
 * outlives any single agent session (and any backend's own session store).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEntry } from '../../shared/model'

const TYPES = ['user', 'feedback', 'project', 'reference'] as const

export class ProjectMemory {
  constructor(private readonly root: string) {}

  private dir(projectId: string): string {
    const d = join(this.root, 'projects', safe(projectId), 'memory')
    mkdirSync(d, { recursive: true })
    return d
  }

  list(projectId: string): MemoryEntry[] {
    const d = this.dir(projectId)
    return readdirSync(d)
      .filter((f) => f.endsWith('.md'))
      .map((f) => this.parse(join(d, f)))
      .filter((m): m is MemoryEntry => !!m)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  read(projectId: string, name: string): MemoryEntry | undefined {
    const f = join(this.dir(projectId), `${slug(name)}.md`)
    return existsSync(f) ? this.parse(f) : undefined
  }

  write(projectId: string, e: { name: string; description: string; type?: string; body: string }): MemoryEntry {
    const name = slug(e.name)
    if (!name) throw new Error('name 不能为空')
    const type = (TYPES as readonly string[]).includes(e.type ?? '') ? e.type! : 'project'
    const description = e.description.replace(/\s+/g, ' ').trim().slice(0, 200)
    const body = e.body.trim()
    if (body.length > 4000) throw new Error('单条记忆不能超过 4000 字，请拆分或精简')
    const text = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`
    writeFileSync(join(this.dir(projectId), `${name}.md`), text)
    return this.read(projectId, name)!
  }

  remove(projectId: string, name: string): boolean {
    const f = join(this.dir(projectId), `${slug(name)}.md`)
    if (!existsSync(f)) return false
    rmSync(f)
    return true
  }

  /** The index every project agent gets in its context. */
  index(projectId: string, limit = Infinity): string {
    // How the user wants things done comes first; then the most recently touched facts.
    const rank = (t: string) => (t === 'user' || t === 'feedback' ? 0 : 1)
    const list = this.list(projectId).sort((a, b) => rank(a.type) - rank(b.type))
    if (!list.length) return '（项目记忆为空）'
    const lines = list.slice(0, limit).map((m) => `- ${m.name} [${m.type}]：${m.description}`)
    if (list.length > limit) lines.push(`- ……另有 ${list.length - limit} 条，用 memory_list 查看全部`)
    return lines.join('\n')
  }

  private parse(file: string): MemoryEntry | undefined {
    try {
      const raw = readFileSync(file, 'utf8')
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
      const meta: Record<string, string> = {}
      for (const line of (m?.[1] ?? '').split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      return {
        name: meta.name || file.replace(/^.*[\\/]/, '').replace(/\.md$/, ''),
        description: meta.description ?? '',
        type: meta.type ?? 'project',
        body: (m?.[2] ?? raw).trim(),
        updatedAt: statSync(file).mtimeMs
      }
    } catch {
      return undefined
    }
  }
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function safe(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '')
}
