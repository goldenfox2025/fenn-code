import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'
import { ComputerControl, defaultTier, type AccessRequest, type TierChoice } from '../src/main/computer/ComputerControl'
import { parseChord, type AppRef, type InputDriver } from '../src/main/computer/drivers'
import { ToolContent } from '../src/main/tools/ToolServer'

const NOTEPAD: AppRef = { id: 'notepad', name: '记事本', pid: 10 }
const TERM: AppRef = { id: 'windowsterminal', name: 'Terminal', pid: 11 }
const COVE: AppRef = { id: 'ancora', name: 'Ancora', pid: 1 }

interface Opts {
  enabled?: boolean
  answer?: Record<string, TierChoice> | null | 'defaults'
  unattended?: boolean
  front?: AppRef
  pasteChord?: string
}

function setup(opts: Opts = {}) {
  const calls: string[] = []
  const requests: AccessRequest[] = []
  const active: boolean[] = []
  const actions: string[] = []
  let front = opts.front ?? NOTEPAD
  let board = 'old'
  const input: InputDriver = {
    name: 'fake',
    unavailable: async () => undefined,
    click: async (x, y, b, n, m) => void calls.push(`click ${x},${y} ${b} ${n}${m?.length ? ' ' + m.join('+') : ''}`),
    move: async (x, y) => void calls.push(`move ${x},${y}`),
    drag: async (a, b, c, d) => void calls.push(`drag ${a},${b} ${c},${d}`),
    scroll: async (x, y, dx, dy) => void calls.push(`scroll ${x},${y} ${dx} ${dy}`),
    type: async (t) => void calls.push(`type ${t}`),
    key: async (k, r) => void calls.push(`key ${k}${r && r > 1 ? ' x' + r : ''}:${board}`),
    holdKey: async (k, ms) => void calls.push(`hold ${k} ${ms}`),
    cursor: async () => ({ x: 1000, y: 500 }),
    frontmost: async () => front,
    // Left half of the 2560-wide screen is Notepad, the right half a terminal, the top-left corner Ancora.
    appAt: async (x, y) => (x < 20 && y < 20 ? COVE : x < 1280 ? NOTEPAD : TERM),
    apps: async () => [NOTEPAD, TERM, COVE],
    open: async (name) => {
      calls.push(`open ${name}`)
      front = name.toLowerCase().includes('term') ? TERM : NOTEPAD
      return front
    }
  }
  const cc = new ComputerControl({
    input,
    // A 2560×1440 screen shown to the agent at 1280×720.
    screen: {
      displays: () => [
        { id: 'd1', name: '内置显示器', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, primary: true },
        { id: 'd2', name: 'DELL', bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, primary: false }
      ],
      capture: async (_d, _w, _h, region) => ({
        data: 'AAAA',
        width: Math.round((region?.width ?? 2560) / 2),
        height: Math.round((region?.height ?? 1440) / 2)
      })
    },
    clipboard: { read: async () => board, write: (t) => void (board = t) },
    pasteChord: opts.pasteChord,
    enabled: () => opts.enabled ?? true,
    askAccess: async (_id, req) => {
      requests.push(req)
      const a = opts.answer === undefined ? 'defaults' : opts.answer
      return a === 'defaults' ? {} : a
    },
    unattended: () => !!opts.unattended,
    isOwnApp: (a) => a.pid === 1 || (!a.pid && a.name.toLowerCase() === 'ancora'),
    onActive: (_id, on) => void active.push(on),
    onAction: (_id, label) => void actions.push(label)
  })
  const tools = cc.tools({ id: 'c1' } as Conversation)
  const call = (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error('no tool ' + name)
    return t.run(args, { conversationId: 'c1' }) as Promise<unknown>
  }
  const grant = async (apps = ['记事本', 'Terminal']) => call('computer_request_access', { apps, reason: '写个文件' })
  return { cc, calls, call, grant, requests, active, actions, setFront: (a: AppRef) => (front = a) }
}

describe('computer control', () => {
  it('asks for apps with default tiers, then maps screenshot pixels to screen points', async () => {
    const { calls, call, grant, requests, actions } = setup()
    const summary = String(await grant())
    expect(requests).toHaveLength(1)
    expect(requests[0].apps).toEqual([
      { key: 'notepad', name: '记事本', tier: 'full', running: true },
      { key: 'windowsterminal', name: 'Terminal', tier: 'click', running: true }
    ])
    expect(summary).toContain('记事本：完全控制')
    expect(summary).toContain('Terminal：仅点击')
    const shot = (await call('computer_screenshot')) as ToolContent
    expect(shot.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(shot.content[0]).toMatchObject({ text: expect.stringContaining('1280×720') })
    expect(shot.content[0]).toMatchObject({ text: expect.stringContaining('前台程序：记事本') })
    await call('computer_double_click', { coordinate: [100, 50] })
    await call('computer_left_click', { coordinate: [100, 50], text: 'shift' })
    await call('computer_scroll', { coordinate: [10, 10], scroll_direction: 'down' })
    await call('computer_key', { text: 'ctrl+s' })
    await call('computer_key', { text: 'down', repeat: 3 })
    expect(calls).toEqual(['click 200,100 left 2', 'click 200,100 left 1 shift', 'scroll 20,20 0 3', 'key ctrl+s:old', 'key down x3:old'])
    expect(actions[0]).toBe('双击 记事本')
  }, 20000)

  it('enforces tiers: click-only apps take clicks but not typing; unlisted apps nothing', async () => {
    const { call, grant, calls, setFront } = setup()
    await grant()
    await call('computer_screenshot')
    await call('computer_left_click', { coordinate: [900, 100] }) // terminal half: allowed
    setFront(TERM)
    await expect(call('computer_type', { text: 'rm -rf /' })).rejects.toThrow('只允许点击')
    await expect(call('computer_key', { text: 'enter' })).rejects.toThrow('只允许点击')
    await expect(call('computer_left_click', { coordinate: [5, 5] })).rejects.toThrow('Ancora 自己的窗口')
    setFront({ id: 'chrome', name: 'Chrome' })
    await expect(call('computer_type', { text: 'x' })).rejects.toThrow('不在允许的程序里')
    expect(calls).toEqual(['click 1800,200 left 1'])
  }, 20000)

  it('honours the tiers the user picked, and a view-only grant can only look', async () => {
    const { call, grant } = setup({ answer: { notepad: 'view', windowsterminal: 'none' } })
    const s = String(await grant())
    expect(s).toContain('用户没有允许：Terminal')
    expect(s).toContain('记事本：仅查看')
    await call('computer_screenshot')
    await expect(call('computer_left_click', { coordinate: [10, 100] })).rejects.toThrow('只允许查看')
    await expect(call('computer_left_click', { coordinate: [900, 100] })).rejects.toThrow('不在允许的程序里')
  })

  it('needs a grant before anything, and a screenshot before clicking', async () => {
    const { call, grant } = setup()
    await expect(call('computer_screenshot')).rejects.toThrow('computer_request_access')
    await grant()
    await expect(call('computer_left_click', { coordinate: [1, 1] })).rejects.toThrow('computer_screenshot')
  })

  it('refuses when the user says no, or when the setting is off', async () => {
    const no = setup({ answer: null })
    await expect(no.grant()).rejects.toThrow('没有允许')
    await expect(no.grant()).rejects.toThrow('没有允许')
    expect(no.requests).toHaveLength(1)
    no.cc.turnEnded('c1')
    await expect(no.grant()).rejects.toThrow('没有允许')
    expect(no.requests).toHaveLength(2)
    // Off: not listed at all, so other chats don't carry the tools.
    const off = setup({ enabled: false })
    expect(off.cc.tools({ id: 'c1' } as never)).toEqual([])
    expect(off.requests).toHaveLength(0)
    const away = setup({ unattended: true })
    await expect(away.grant()).rejects.toThrow('无人值守')
    expect(away.requests).toHaveLength(0)
  })

  it('offers every agent the tools; the first screenshot tells a model that can\'t see it to stop and say so', async () => {
    const { cc, call, grant } = setup()
    expect(cc.tools({ id: 'c1' } as never).length).toBeGreaterThan(1)
    await grant()
    const text = (r: unknown) => JSON.stringify(r)
    expect(text(await call('computer_screenshot'))).toContain('换一个能看图片的模型')
    expect(text(await call('computer_screenshot'))).not.toContain('换一个能看图片的模型')
  })

  it('gets the app out of the way while controlling, and stop withdraws the grant', async () => {
    const { cc, call, grant, active, requests } = setup()
    await grant()
    await call('computer_screenshot')
    expect(active).toEqual([true])
    cc.turnEnded('c1')
    expect(active).toEqual([true, false])
    await call('computer_screenshot') // grant still fresh: no new question
    expect(requests).toHaveLength(1)
    cc.revoke('c1')
    expect(active).toEqual([true, false, true, false])
    await expect(call('computer_screenshot')).rejects.toThrow('没有允许')
    await expect(grant()).rejects.toThrow('没有允许')
    expect(requests).toHaveLength(1)
    cc.turnEnded('c1')
    await grant()
    expect(requests).toHaveLength(2)
  })

  it('zooms into a region, switches displays and maps the second display', async () => {
    const { call, grant, calls } = setup()
    await grant()
    await call('computer_screenshot')
    const z = (await call('computer_zoom', { region: [0, 0, 320, 180] })) as ToolContent
    expect(z.content[0]).toMatchObject({ text: expect.stringContaining('放大') })
    // Zooming doesn't change what coordinates mean.
    await call('computer_left_click', { coordinate: [100, 50] })
    const s = (await call('computer_switch_display', { display: '2' })) as ToolContent
    expect(s.content[0]).toMatchObject({ text: expect.stringContaining('DELL') })
    await call('computer_left_click', { coordinate: [100, 50] })
    expect(calls).toEqual(['click 200,100 left 1', 'click 2760,100 left 1'])
  })

  it('runs a batch and stops at the first refused action', async () => {
    const { call, grant, calls, setFront } = setup()
    await grant()
    await call('computer_screenshot')
    const ok = (await call('computer_batch', {
      actions: [
        { action: 'left_click', coordinate: [100, 50] },
        { action: 'type', text: 'hello' },
        { action: 'key', text: 'enter' }
      ]
    })) as ToolContent
    expect(ok.content[0]).toMatchObject({ text: expect.stringContaining('3 个操作都已完成') })
    setFront(TERM)
    const bad = (await call('computer_batch', {
      actions: [
        { action: 'left_click', coordinate: [900, 50] },
        { action: 'type', text: 'oops' },
        { action: 'key', text: 'enter' }
      ]
    })) as ToolContent
    expect(bad.content[0]).toMatchObject({ text: expect.stringContaining('第 2 个操作失败') })
    expect(calls).toEqual(['click 200,100 left 1', 'type hello', 'key enter:old', 'click 1800,100 left 1'])
  }, 20000)

  it('opens only granted apps', async () => {
    const { call, grant, calls } = setup()
    await grant(['记事本'])
    await expect(call('computer_open_application', { app: 'Terminal' })).rejects.toThrow('不在允许的程序里')
    const r = (await call('computer_open_application', { app: '记事本' })) as ToolContent
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining('已打开「记事本」') })
    expect(calls).toEqual(['open 记事本'])
  })

  it('pastes non-ASCII text where key events cannot type it, and restores the clipboard', async () => {
    const { call, grant, calls } = setup({ pasteChord: 'cmd+v' })
    await grant()
    await call('computer_screenshot')
    await call('computer_type', { text: '你好' })
    await call('computer_type', { text: 'hi' })
    expect(calls).toEqual(['key cmd+v:你好', 'type hi'])
    expect(String(await call('computer_read_clipboard'))).toBe('old')
  }, 20000)

  it('keeps the clipboard away from view-only apps, and never offers Ancora itself', async () => {
    const viewOnly = setup({ answer: { notepad: 'click', keepass: 'view' } })
    await viewOnly.call('computer_request_access', { apps: ['记事本', 'KeePass'] })
    await expect(viewOnly.call('computer_read_clipboard')).rejects.toThrow('完全控制')
    await expect(viewOnly.call('computer_write_clipboard', { text: 'x' })).rejects.toThrow('完全控制')

    const mixed = setup({ answer: { notepad: 'full', keepass: 'view' } })
    await mixed.call('computer_request_access', { apps: ['记事本', 'KeePass'] })
    await expect(mixed.call('computer_read_clipboard')).rejects.toThrow('「KeePass」只允许查看')
    expect(String(await mixed.call('computer_write_clipboard', { text: 'x' }))).toBe('已写入剪贴板。')

    const own = setup()
    await own.call('computer_request_access', { apps: ['记事本', 'ancora'] })
    expect(own.requests[0].apps.map((a) => a.key)).toEqual(['notepad'])
  })

  it('picks default tiers by kind of app', () => {
    expect(defaultTier({ key: 'code', name: 'Visual Studio Code' })).toBe('click')
    expect(defaultTier({ key: 'com.apple.terminal', name: 'Terminal' })).toBe('click')
    expect(defaultTier({ key: '1password', name: '1Password' })).toBe('view')
    expect(defaultTier({ key: 'excel', name: 'Microsoft Excel' })).toBe('full')
    expect(defaultTier({ key: 'barcode', name: 'Barcode Studio' })).toBe('full')
  })

  it('parses key chords', () => {
    expect(parseChord('Ctrl+Shift+T')).toEqual({ mods: ['ctrl', 'shift'], key: 't' })
    expect(parseChord('command+space')).toEqual({ mods: ['cmd'], key: 'space' })
    expect(parseChord('Return')).toEqual({ mods: [], key: 'enter' })
    expect(parseChord('ctrl++')).toEqual({ mods: ['ctrl'], key: '+' })
  })
})
