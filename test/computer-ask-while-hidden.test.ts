import { describe, expect, it } from 'vitest'
import type { Conversation } from '../src/shared/model'
import { ComputerControl, type TierChoice } from '../src/main/computer/ComputerControl'
import { ControlWindow, type WindowLike } from '../src/main/computer/controlWindow'
import type { AppRef, InputDriver } from '../src/main/computer/drivers'

const NOTEPAD: AppRef = { id: 'notepad', name: '记事本', pid: 10 }
const PAINT: AppRef = { id: 'mspaint', name: '画图', pid: 12 }

/** A main window that only keeps its state, as Electron's would. */
function fakeWindow() {
  const s = { visible: true, minimized: false, focused: 0 }
  const w: WindowLike = {
    isVisible: () => s.visible,
    isMinimized: () => s.minimized,
    hide: () => void (s.visible = false),
    minimize: () => void (s.minimized = true),
    restore: () => void (s.minimized = false),
    show: () => void (s.visible = true),
    showInactive: () => void (s.visible = true),
    focus: () => void s.focused++
  }
  const shown = () => s.visible && !s.minimized
  return { w, s, shown }
}

/**
 * The window policy wired to ComputerControl the way the app wires it: the card
 * for a second request must not sit in a hidden window (QA: declined after 3 minutes unseen).
 */
function setup(platform: NodeJS.Platform) {
  const win = fakeWindow()
  const policy = new ControlWindow(() => win.w, platform)
  let reply: (a: Record<string, TierChoice> | null) => void = () => {}
  const seenWhileAsking: boolean[] = []
  const input = {
    name: 'fake',
    unavailable: async () => undefined,
    click: async () => {},
    move: async () => {},
    drag: async () => {},
    scroll: async () => {},
    type: async () => {},
    key: async () => {},
    holdKey: async () => {},
    cursor: async () => ({ x: 0, y: 0 }),
    frontmost: async () => NOTEPAD,
    appAt: async () => NOTEPAD,
    apps: async () => [NOTEPAD, PAINT]
  } as unknown as InputDriver
  const cc = new ComputerControl({
    screen: {
      displays: () => [{ id: 'd1', name: '显示器', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, primary: true }],
      capture: async () => ({ data: 'AAAA', width: 1280, height: 720 })
    },
    input,
    clipboard: { read: async () => '', write: () => {} },
    enabled: () => true,
    askAccess: () =>
      new Promise((resolve) => {
        seenWhileAsking.push(win.shown())
        reply = resolve
      }),
    onActive: (id, on) => policy.setActive(id, on),
    onAsking: (id, on) => policy.setAsking(id, on)
  })
  const tools = cc.tools({ id: 'c1' } as Conversation)
  const call = (name: string, args: Record<string, unknown> = {}) => tools.find((x) => x.name === name)!.run(args, { conversationId: 'c1' }) as Promise<unknown>
  return { win, call, answer: (a: Record<string, TierChoice> | null) => reply(a), seenWhileAsking }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

for (const platform of ['linux', 'win32', 'darwin'] as const) {
  describe(`asking for another app while in control (${platform})`, () => {
    it('brings the window back while the card waits, and steps aside again after the answer', async () => {
      const { win, call, answer, seenWhileAsking } = setup(platform)
      const first = call('computer_request_access', { apps: ['记事本'] })
      await settle()
      answer({})
      await first
      await call('computer_screenshot')
      await call('computer_left_click', { coordinate: [100, 50] })
      expect(win.shown()).toBe(false) // out of the way while the agent acts

      const second = call('computer_request_access', { apps: ['画图'] })
      await settle()
      expect(seenWhileAsking).toEqual([true, true]) // the second card is on screen
      expect(win.s.focused).toBeGreaterThan(0)
      answer({ mspaint: 'full' })
      expect(String(await second)).toContain('画图')
      expect(win.shown()).toBe(false) // control goes on: hidden again
    })

    it('steps aside again when the request goes unanswered too', async () => {
      const { win, call, answer } = setup(platform)
      const first = call('computer_request_access', { apps: ['记事本'] })
      await settle()
      answer({})
      await first
      await call('computer_screenshot')
      await call('computer_left_click', { coordinate: [100, 50] })
      const second = call('computer_request_access', { apps: ['画图'] })
      await settle()
      expect(win.shown()).toBe(true)
      answer(null)
      await expect(second).rejects.toThrow()
      expect(win.shown()).toBe(false)
    })
  })
}

describe('the main window around control', () => {
  it('comes back when control ends, but not a window the user minimized before', () => {
    const { w, s, shown } = fakeWindow()
    const p = new ControlWindow(() => w, 'win32')
    p.setActive('a', true)
    expect(shown()).toBe(false)
    p.setActive('a', false)
    expect(shown()).toBe(true)
    s.minimized = true
    p.setActive('a', true)
    p.setActive('a', false)
    expect(s.minimized).toBe(true)
  })
})
