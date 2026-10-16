import { plainPreview } from '../src/main/core/ChatService'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store/Store'

describe('store durability', () => {
  it('falls back to the previous version when state.json is damaged, keeping the damaged copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-store-'))
    const a = new Store(dir)
    a.patchSettings({ userName: '第一版' })
    a.flush()
    a.patchSettings({ userName: '第二版' })
    a.flush()
    // A crash mid-write (or a disk glitch) leaves garbage behind.
    writeFileSync(join(dir, 'state.json'), '{"projects": [')
    const b = new Store(dir)
    expect(b.settings.userName).toBe('第一版')
    expect(readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true)
    expect(existsSync(join(dir, 'state.json.bak'))).toBe(true)
  })
})

it('previews read as plain text', () => {
  expect(plainPreview('这是来自**演示 Agent** 的回复（模型：`mock-fast`）。\n\n> 你好\n\n- 一\n- [链接](https://x.y)\n```js\nx()\n```\n# 标题')).toBe(
    '这是来自演示 Agent 的回复（模型：mock-fast）。 你好 一 链接 标题'
  )
})
