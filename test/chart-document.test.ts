import { describe, expect, it } from 'vitest'
import { chartDocument, type ChartSpec } from '../src/main/core/chartDocument'
import { makeCore, until } from './helpers'

const spec: ChartSpec = { title: 'Usage', type: 'line', labels: ['A', 'B'], series: [{ name: 'Input', values: [1, null] }] }

describe('embedded charts', () => {
  it('ships the renderer offline, keeps missing values and escapes supplied markup', () => {
    const doc = chartDocument({ ...spec, title: '<script>bad</script>', labels: ['</script><script>bad</script>', 'B'] })
    expect(doc).toContain('Chart.js v4.5.1')
    expect(doc).toContain('data-fenn-chart')
    expect(doc).toContain('\\u003c/script>')
    expect(doc).not.toContain('<script>bad</script>')
    expect(doc).toContain('[1,null]')
    expect(doc).not.toContain('<script src=')
  })
  it.each([
    { ...spec, type: 'pie' }, { ...spec, labels: [] },
    { ...spec, series: [{ name: 'X', values: [1] }] },
    { ...spec, series: [{ name: 'X', values: [Infinity, 2] }] },
    { ...spec, series: [{ name: 'X', values: ['1', 2] }] }
  ])('rejects invalid chart data rather than drawing incorrect values', (bad) => expect(() => chartDocument(bad)).toThrow())
  it('publishes and versions charts through the same backend-neutral artifact tool', async () => {
    const { core, store, dispose } = await makeCore()
    try {
      const c = await core.startChat({ text: '#折线图', backendId: 'mock' })
      await until(() => store.conversation(c.id)?.status === 'idle')
      const first = core.artifacts.list().find((a) => a.conversationId === c.id)!
      expect(first).toBeDefined()
      expect(core.artifacts.html(first.id)).toContain('data-fenn-chart')
      expect(store.messagesOf(c.id).flatMap((m) => m.blocks)).toContainEqual(expect.objectContaining({ type: 'artifact', display: 'inline' }))
      await core.send(c.id, '#柱状图')
      await until(() => store.conversation(c.id)?.status === 'idle')
      expect(core.artifacts.meta(first.id)?.versions).toHaveLength(2)
      expect(core.artifacts.html(first.id)).toContain('"type":"bar"')
    } finally { await dispose() }
  }, 30000)
})
