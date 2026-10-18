import { describe, expect, it } from 'vitest'
import { runStreaming } from '../src/main/backends/upgrade'

describe('installing a backend on a machine without Node.js', () => {
  it('says to install Node.js first instead of a bare spawn error', async () => {
    const saved = { PATH: process.env.PATH, Path: process.env.Path }
    process.env.PATH = ''
    delete process.env.Path
    try {
      const lines: string[] = []
      const r = await runStreaming({ command: 'npm', args: ['install', '-g', 'x'] }, (l) => lines.push(l))
      expect(r.ok).toBe(false)
      expect(lines.join('\n')).toContain('nodejs.org')
    } finally {
      process.env.PATH = saved.PATH
      if (saved.Path !== undefined) process.env.Path = saved.Path
    }
  })
})
