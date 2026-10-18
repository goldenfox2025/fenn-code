/**
 * The app's data folder has moved before (openclaude → Cove → Ancora → Fenn
 * Code). Saved chats and projects keep absolute paths into it (output cards,
 * the folders made for chats), so on reading, a path into an old folder is
 * pointed at the same place in the new one.
 */

/** A folder whose contents now live in `to`. */
export interface MovedFolder {
  from: string
  to: string
}

/** One pattern per moved folder: its path as whole path segments, either slash, any case on Windows paths. */
function patterns(moved: MovedFolder[]): { re: RegExp; to: string }[] {
  return moved.map(({ from, to }) => {
    const parts = from.replace(/[\\/]+$/, '').split(/[\\/]+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const windows = /^[A-Za-z]:/.test(from) || from.includes('\\')
    // The folder ends at a separator, the end of the text, or (in prose) a quote, bracket or CJK punctuation; never a space: "Ancora notes" is another folder.
    return { re: new RegExp(parts.join('[\\\\/]') + '(?=[\\\\/]|$|["\'`)\\]>]|[\\u3000-\\u303f\\uff00-\\uffef])', windows ? 'gi' : 'g'), to: to.replace(/[\\/]+$/, '') }
  })
}

/**
 * Rewrites, in place, every string inside `value` that names something in a
 * moved folder; true when anything changed.
 */
export function remapMovedPaths(value: unknown, moved: MovedFolder[]): boolean {
  if (!moved.length || value === null || typeof value !== 'object') return false
  const pats = patterns(moved)
  let changed = false
  const fix = (s: string): string => {
    let out = s
    for (const { re, to } of pats) out = out.replace(re, () => to)
    if (out !== s) changed = true
    return out
  }
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) typeof v[i] === 'string' ? (v[i] = fix(v[i])) : walk(v[i])
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const k of Object.keys(o)) typeof o[k] === 'string' ? (o[k] = fix(o[k] as string)) : walk(o[k])
    }
  }
  walk(value)
  return changed
}
