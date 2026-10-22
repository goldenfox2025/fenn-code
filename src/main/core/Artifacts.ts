/**
 * Artifacts: self-contained HTML pages an agent publishes (a report, a chart,
 * a small app), shown beside the conversation like Claude's artifacts. Each
 * publish to the same id adds a version.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { uiDisplayDocument } from './uiDocument'

export interface ArtifactMeta {
  id: string
  title: string
  conversationId: string
  versions: { version: number; createdAt: number }[]
}

const MAX_HTML = 2_000_000
const MAX_DISPLAY_BYTES = 8 * 1024 * 1024
const MAX_DISPLAY_ENTRIES = 16

export class Artifacts {
  private readonly displayed = new Map<string, { html: string; bytes: number }>()
  private displayedBytes = 0
  constructor(private readonly root: string) {}

  private dir(id: string): string {
    return join(this.root, 'artifacts', id.replace(/[^a-zA-Z0-9-]/g, ''))
  }

  meta(id: string): ArtifactMeta | undefined {
    const f = join(this.dir(id), 'meta.json')
    if (!existsSync(f)) return undefined
    try {
      return JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      return undefined
    }
  }

  html(id: string, version?: number): string | undefined {
    const m = this.meta(id)
    if (!m) return undefined
    const v = version ?? m.versions[m.versions.length - 1]?.version
    const f = join(this.dir(id), `v${v}.html`)
    return existsSync(f) ? readFileSync(f, 'utf8') : undefined
  }

  /** Versions are immutable. Reuse their prepared display document in this
   * process, with limits on both bytes and entries (including large charts). */
  displayHtml(id: string, version?: number): string | undefined {
    const current = version ?? this.meta(id)?.versions.at(-1)?.version
    if (current === undefined) return undefined
    const key = `${id}:${current}`
    const cached = this.displayed.get(key)
    if (cached) {
      this.displayed.delete(key)
      this.displayed.set(key, cached)
      return cached.html
    }
    const source = this.html(id, current)
    if (source === undefined) return undefined
    const html = uiDisplayDocument(source)
    const bytes = Buffer.byteLength(html)
    if (bytes > MAX_DISPLAY_BYTES) return html
    this.displayed.set(key, { html, bytes })
    this.displayedBytes += bytes
    while (this.displayed.size > MAX_DISPLAY_ENTRIES || this.displayedBytes > MAX_DISPLAY_BYTES) {
      const oldest = this.displayed.keys().next().value!
      this.displayedBytes -= this.displayed.get(oldest)!.bytes
      this.displayed.delete(oldest)
    }
    return html
  }

  /** Creates an artifact, or adds a version when `id` names one from the same conversation. */
  publish(conversationId: string, title: string, html: string, id?: string): { meta: ArtifactMeta; version: number } {
    if (!html.trim()) throw new Error('html 不能为空')
    if (html.length > MAX_HTML) throw new Error('页面太大（上限约 2 MB）')
    let meta = id ? this.meta(id) : undefined
    if (id && !meta) throw new Error(`没有 id 为 ${id} 的页面`)
    if (meta && meta.conversationId !== conversationId) throw new Error('只能更新本对话发布的页面')
    meta ??= { id: randomUUID(), title, conversationId, versions: [] }
    meta.title = title || meta.title
    const version = (meta.versions[meta.versions.length - 1]?.version ?? 0) + 1
    meta.versions.push({ version, createdAt: Date.now() })
    const d = this.dir(meta.id)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `v${version}.html`), html)
    writeFileSync(join(d, 'meta.json'), JSON.stringify(meta))
    return { meta, version }
  }

  /** Where the page's latest (or given) version is saved. */
  file(id: string, version?: number): string | undefined {
    const m = this.meta(id)
    const v = version ?? m?.versions[m.versions.length - 1]?.version
    return m && v !== undefined ? join(this.dir(id), `v${v}.html`) : undefined
  }

  list(): ArtifactMeta[] {
    const d = join(this.root, 'artifacts')
    if (!existsSync(d)) return []
    return readdirSync(d)
      .map((id) => this.meta(id))
      .filter((m): m is ArtifactMeta => !!m)
  }
}
