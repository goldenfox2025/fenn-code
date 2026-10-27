export interface ReviewDiffLine {
  kind: 'context' | 'added' | 'removed' | 'hunk'
  text: string
  oldLine?: number
  newLine?: number
}

/** Git's file metadata never reaches the code viewer; only hunks and numbered source lines do. */
export function reviewDiffLines(patch: string): ReviewDiffLine[] {
  const result: ReviewDiffLine[] = []
  let oldLine = 0, newLine = 0, inHunk = false
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(row)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true
      result.push({ kind: 'hunk', text: hunk[3].trim(), oldLine, newLine })
    } else if (inHunk && row.startsWith('+')) result.push({ kind: 'added', text: row.slice(1), newLine: newLine++ })
    else if (inHunk && row.startsWith('-')) result.push({ kind: 'removed', text: row.slice(1), oldLine: oldLine++ })
    else if (inHunk && row.startsWith(' ')) result.push({ kind: 'context', text: row.slice(1), oldLine: oldLine++, newLine: newLine++ })
  }
  return result
}
