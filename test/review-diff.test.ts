import { expect, it } from 'vitest'
import { reviewDiffLines } from '../src/shared/reviewDiff'

it('renders numbered source edits without Git metadata, preserving indentation and blank lines', () => {
  const patch = 'diff --git a/a.ts b/a.ts\nindex abc..def 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,4 @@ function value()\n   const old = 1\n-  return old\n+  const next = old + 1\n+  return next\n \n'
  const lines = reviewDiffLines(patch)
  expect(lines.map((l) => l.kind)).toEqual(['hunk', 'context', 'removed', 'added', 'added', 'context'])
  expect(lines.find((l) => l.kind === 'removed')).toMatchObject({ oldLine: 3, text: '  return old' })
  expect(lines.filter((l) => l.kind === 'added').map((l) => l.newLine)).toEqual([3, 4])
  expect(lines.at(-1)).toMatchObject({ oldLine: 4, newLine: 5, text: '' })
  expect(lines.some((l) => /diff --git|index abc/.test(l.text))).toBe(false)
})
