/**
 * Computer control as agent tools, modelled on Claude's computer use: the
 * agent sees real screenshots and drives the mouse and keyboard in other apps.
 *
 * - Off unless the user turns it on in settings.
 * - The agent first asks for the apps it needs (computer_request_access). The
 *   user grants each app a tier: full control, click only, or view only.
 *   Clicks are checked against the app under the pointer, typing and keys
 *   against the app that has focus; Fenn Code's own windows are never touched.
 * - A grant lasts while the agent keeps working and ends when the user presses
 *   Stop or after GRANT_IDLE_MS without actions.
 * - Every agent gets the tools; a model that can't look at images is told by
 *   the screenshot itself to stop and ask the user for another model.
 *
 * Coordinates the agent uses are pixels of the last screenshot it was given;
 * they're mapped back to screen points here, so the agent never has to know
 * the display's real size, position or scale.
 */
import type { Conversation } from '../../shared/model'
import { ToolContent, type ToolDef } from '../tools/ToolServer'
import type { AppRef, InputDriver, MouseButton } from './drivers'
import { t, tk } from '../../shared/i18n'

export type Tier = 'view' | 'click' | 'full'
export type TierChoice = Tier | 'none'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: string
  name: string
  /** In logical points, in the desktop's coordinate space. */
  bounds: Rect
  primary: boolean
}

export interface Shot {
  /** base64 PNG */
  data: string
  width: number
  height: number
}

export interface ScreenSource {
  displays(): DisplayInfo[]
  /** Captures a display (or a region of it, in the display's own points) scaled to fit max × maxHeight. */
  capture(displayId: string, maxWidth: number, maxHeight: number, region?: Rect): Promise<Shot>
}

export interface AccessRequest {
  reason: string
  apps: { key: string; name: string; tier: Tier; running: boolean }[]
}

export interface ComputerDeps {
  screen: ScreenSource
  input: InputDriver
  clipboard?: { read(): string | Promise<string>; write(text: string): void | Promise<void> }
  /**
   * Set where synthetic key events can't produce non-ASCII text (macOS): such
   * text is pasted through the clipboard with this chord instead.
   */
  pasteChord?: string
  enabled(): boolean
  /** Asks the user which apps to allow and how far; null when declined or unanswered. */
  askAccess(conversationId: string, req: AccessRequest): Promise<Record<string, TierChoice> | null>
  /** Nobody is watching this turn (a scheduled task): never ask, just fail. */
  unattended?(conversationId: string): boolean
  /** Fenn Code's own windows, which the agent must never act on. */
  isOwnApp?(app: AppRef): boolean
  /**
   * Control starts or stops in a conversation. The app gets out of the way
   * (so the agent doesn't click its own window) and shows a stop control.
   */
  onActive?(conversationId: string, active: boolean): void
  /** What the agent is doing now, for the stop control. */
  onAction?(conversationId: string, label: string): void
  /** Overrides ANSWER_WAIT_MS (tests). */
  answerWaitMs?: number
  /** A conversation asks the user for access, or has its answer: the app brings the question in front while it waits. */
  onAsking?(conversationId: string, asking: boolean): void
}

/** How long computer_request_access waits for the user before returning "not answered yet" (agents' tool deadlines are ~3 min). */
export const ANSWER_WAIT_MS = 150_000

/** A grant lasts this long after the agent's last action; then it asks again. */
export const GRANT_IDLE_MS = 30 * 60_000

const MAX_WIDTH = 1280
const MAX_HEIGHT = 900
const SETTLE_MS = 500
const RANK: Record<Tier, number> = { view: 0, click: 1, full: 2 }
export const TIER_LABEL: Record<TierChoice, string> = {
  full: '完全控制',
  click: '仅点击',
  view: '仅查看',
  none: '不允许'
}

/** Terminals and code editors: clicking is fine, but typing there runs commands, so it's off by default. */
const CLICK_ONLY =
  /\b(terminal|windowsterminal|wt|powershell|pwsh|cmd|conhost|iterm2?|alacritty|kitty|konsole|gnome-terminal(-server)?|xterm|warp|wezterm(-gui)?|hyper|tabby|code|code - insiders|visual studio code|cursor|windsurf|devenv|idea(64)?|pycharm(64)?|webstorm(64)?|goland(64)?|clion(64)?|rider(64)?|studio64|xcode|sublime_text|sublime text|zed)\b/i
/** Password managers and keychains: look, don't touch. */
const VIEW_ONLY = /(1password|bitwarden|keepass(xc)?|lastpass|dashlane|enpass|keychain access|钥匙串)/i

export function defaultTier(app: { key: string; name: string }): Tier {
  const s = `${app.key} ${app.name}`
  if (VIEW_ONLY.test(s)) return 'view'
  if (CLICK_ONLY.test(s)) return 'click'
  return 'full'
}

export function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.(exe|app)$/, '')
}

interface Grant {
  key: string
  name: string
  tier: Tier
}

interface Session {
  grants: Grant[]
  until: number
  display?: string
  /** Last screenshot: display, captured region (points) and image size. */
  geometry?: { display: string; region: Rect; width: number; height: number }
}

type Args = Record<string, unknown>

export class ComputerControl {
  private sessions = new Map<string, Session>()
  /** Declined or stopped for the rest of the current turn. */
  private denied = new Set<string>()
  private active = new Set<string>()
  private asking = new Map<string, Promise<string>>()

  constructor(private readonly deps: ComputerDeps) {}

  /** Forget a conversation's grant (e.g. when it's deleted). */
  forget(conversationId: string): void {
    this.turnEnded(conversationId)
    this.sessions.delete(conversationId)
  }

  /** A turn finished: give the screen back and let a declined request be asked again next time. */
  turnEnded(conversationId: string): void {
    this.denied.delete(conversationId)
    if (this.active.delete(conversationId)) this.deps.onActive?.(conversationId, false)
  }

  /**
   * The user pressed Stop: the grant is withdrawn, and anything the agent
   * still tries in this turn is refused without asking again (a fresh prompt
   * right after Stop is too easy to click through).
   */
  revoke(conversationId: string): void {
    this.sessions.delete(conversationId)
    this.denied.add(conversationId)
    if (this.active.delete(conversationId)) this.deps.onActive?.(conversationId, false)
  }

  isActive(conversationId: string): boolean {
    return this.active.has(conversationId)
  }

  granted(conversationId: string): Grant[] {
    const s = this.sessions.get(conversationId)
    return s && s.until > Date.now() ? s.grants : []
  }

  /**
   * Listed only while computer control is on, so other sessions don't carry
   * ~5000 characters of tools they don't need. Turning
   * the setting on reopens sessions (ChatService.refreshTools) to pick them up.
   */
  tools(conv: Conversation): ToolDef[] {
    const id = conv.id
    if (!this.deps.enabled()) return []
    const coordinate = {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: '[x, y]，按最近一张截图的像素计'
    }
    const modifiers = {
      type: 'string',
      description: '点击时按住的修饰键，例如 "shift"、"ctrl"、"cmd+shift"（可选）'
    }
    const tool = (
      name: string,
      description: string,
      properties: Record<string, unknown>,
      required: string[],
      run: (a: Args) => Promise<ToolContent | string>
    ): ToolDef => ({
      name: `computer_${name}`,
      description,
      inputSchema: { type: 'object', properties, required },
      run: async (a: Args) => {
        this.ensureUsable(id)
        return run(a)
      }
    })
    const action = (fn: (a: Args) => Promise<void>) => async (a: Args) => {
      await this.gate(id)
      await fn(a)
      await sleep(SETTLE_MS)
      return this.screenshot(id, '完成。')
    }
    const clickTool = (name: string, label: string, button: MouseButton, count: number) =>
      tool(name, `${label}。点击前会检查指针下的程序是否允许点击。`, { coordinate, text: modifiers }, ['coordinate'], action((a) => this.doClick(id, a, button, count)))

    const all: ToolDef[] = [
      tool(
        'request_access',
        '操控电脑前先调用：列出要操作的程序（用用户能看懂的名字，例如「记事本」「Excel」「Safari」），说明原因。用户会为每个程序选择 完全控制 / 仅点击 / 仅查看。之后只能操作被允许的程序。',
        {
          apps: { type: 'array', items: { type: 'string' }, description: '要操作的程序名称' },
          reason: { type: 'string', description: '一句话说明要做什么' }
        },
        ['apps', 'reason'],
        (a) => this.requestAccess(id, a)
      ),
      tool('list_granted_applications', '列出这次被允许操作的程序和各自的权限。', {}, [], async () => {
        const g = this.granted(id)
        if (!g.length) return '还没有被允许的程序。先调用 computer_request_access。'
        return g.map((x) => `${x.name}：${TIER_LABEL[x.tier]}`).join('\n')
      }),
      tool('screenshot', '截取当前屏幕。之后所有坐标都以这张截图的像素为准。', {}, [], async () => {
        await this.gate(id)
        return this.screenshot(id)
      }),
      tool(
        'zoom',
        '放大查看截图的一个区域（看清小字或小图标）。区域按截图像素给出；之后的坐标仍以完整截图为准。',
        { region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1]' } },
        ['region'],
        async (a) => {
          await this.gate(id)
          return this.zoom(id, a.region)
        }
      ),
      clickTool('left_click', '在某个位置单击左键', 'left', 1),
      clickTool('double_click', '在某个位置双击', 'left', 2),
      clickTool('triple_click', '在某个位置三击（选中整行或整段）', 'left', 3),
      clickTool('right_click', '在某个位置单击右键', 'right', 1),
      clickTool('middle_click', '在某个位置单击中键', 'middle', 1),
      tool(
        'mouse_move',
        '把鼠标移到某个位置（用于悬停）。',
        { coordinate },
        ['coordinate'],
        action(async (a) => {
          const [x, y] = this.point(id, a.coordinate)
          await this.deps.input.move(x, y)
        })
      ),
      tool(
        'left_click_drag',
        '按住左键从 start_coordinate 拖到 coordinate。',
        { start_coordinate: coordinate, coordinate },
        ['start_coordinate', 'coordinate'],
        action((a) => this.doDrag(id, a))
      ),
      tool(
        'scroll',
        '在某个位置滚动。',
        {
          coordinate,
          scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          scroll_amount: { type: 'integer', description: '滚动格数，默认 3' }
        },
        ['coordinate', 'scroll_direction'],
        action((a) => this.doScroll(id, a))
      ),
      tool(
        'type',
        '在当前焦点处输入文字（支持中文）。先点击要输入的位置。',
        { text: { type: 'string' } },
        ['text'],
        action((a) => this.doType(id, a))
      ),
      tool(
        'key',
        '按一个键或组合键，例如 "enter"、"escape"、"ctrl+s"、"cmd+space"、"alt+tab"。',
        { text: { type: 'string', description: '按键或组合键' }, repeat: { type: 'integer', description: '重复次数，默认 1' } },
        ['text'],
        action((a) => this.doKey(id, a))
      ),
      tool(
        'hold_key',
        '按住一个键或组合键一段时间再松开。',
        { text: { type: 'string' }, duration: { type: 'number', description: '秒，最多 10' } },
        ['text', 'duration'],
        action((a) => this.doHold(id, a))
      ),
      tool('wait', '等待一会儿（例如等页面加载），然后返回新截图。', { duration: { type: 'number', description: '秒，最多 30' } }, ['duration'], action((a) => sleep(clamp(Number(a.duration) || 1, 0.1, 30) * 1000))),
      tool('cursor_position', '鼠标现在的位置（截图像素）。', {}, [], async () => {
        await this.gate(id)
        const p = await this.deps.input.cursor()
        const [x, y] = this.fromScreen(id, p.x, p.y)
        return `鼠标在 (${x}, ${y})。`
      }),
      tool(
        'open_application',
        '打开一个被允许的程序，或把它切到前台。比点击任务栏或程序坞更可靠。',
        { app: { type: 'string', description: '程序名称' } },
        ['app'],
        async (a) => {
          await this.gate(id)
          const name = String(a.app ?? '').trim()
          if (!name) throw new Error('app 不能为空')
          const g = this.findGrant(id, { id: name, name })
          if (!g) throw new Error(`「${name}」不在允许的程序里。先用 computer_request_access 申请。`)
          this.deps.onAction?.(id, t('打开 {0}', g.name))
          const app = await this.deps.input.open(name)
          await sleep(SETTLE_MS)
          const note = app && !this.match(id, app) ? `注意：现在前台的是「${app.name}」，它不在允许的程序里。` : ''
          return this.screenshot(id, `已打开「${app?.name ?? name}」。${note}`)
        }
      ),
      tool('read_clipboard', '读取剪贴板里的文字。需要至少一个程序是「完全控制」。', {}, [], async () => {
        await this.gate(id)
        this.clipboardAllowed(id, '读取')
        if (!this.deps.clipboard) throw new Error('这台电脑上不能读剪贴板。')
        return String(await this.deps.clipboard.read())
      }),
      tool('write_clipboard', '把文字写入剪贴板。需要至少一个程序是「完全控制」。', { text: { type: 'string' } }, ['text'], async (a) => {
        await this.gate(id)
        this.clipboardAllowed(id, '写入')
        if (!this.deps.clipboard) throw new Error('这台电脑上不能写剪贴板。')
        await this.deps.clipboard.write(String(a.text ?? ''))
        return '已写入剪贴板。'
      }),
      tool(
        'switch_display',
        '有多个显示器时，切换要查看和操作的显示器。填显示器名称或序号（从 1 开始）。',
        { display: { type: 'string' } },
        ['display'],
        async (a) => {
          await this.gate(id)
          const list = this.deps.screen.displays()
          const want = String(a.display ?? '').trim()
          const n = Number(want)
          const d =
            (Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined) ??
            list.find((x) => x.id === want || x.name.toLowerCase() === want.toLowerCase())
          if (!d) throw new Error(`没有这个显示器。可选：${list.map((x, i) => `${i + 1}. ${x.name}`).join('，')}`)
          this.session(id).display = d.id
          return this.screenshot(id, `已切换到「${d.name}」。`)
        }
      ),
      tool(
        'batch',
        '连续执行几个操作，最后只返回一张截图。每项是 {"action": "left_click", "coordinate": [x, y]} 这样的对象，action 可用 left_click、double_click、triple_click、right_click、middle_click、mouse_move、left_click_drag、scroll、type、key、hold_key、wait，其余字段和对应工具相同。遇到错误就停下。',
        { actions: { type: 'array', items: { type: 'object' } } },
        ['actions'],
        async (a) => {
          await this.gate(id)
          const list = Array.isArray(a.actions) ? (a.actions as Args[]) : []
          if (!list.length) throw new Error('actions 不能为空')
          if (list.length > 30) throw new Error('一次最多 30 个操作')
          for (let i = 0; i < list.length; i++) {
            try {
              await this.runBatchItem(id, list[i])
            } catch (e) {
              const shot = await this.screenshot(id, `第 ${i + 1} 个操作失败：${e instanceof Error ? e.message : e}。前面 ${i} 个已完成。`)
              return shot
            }
            await sleep(120)
          }
          await sleep(SETTLE_MS)
          return this.screenshot(id, `${list.length} 个操作都已完成。`)
        }
      )
    ]
    return all
  }

  private async runBatchItem(id: string, a: Args): Promise<void> {
    switch (String(a.action ?? '')) {
      case 'left_click':
        return this.doClick(id, a, 'left', 1)
      case 'double_click':
        return this.doClick(id, a, 'left', 2)
      case 'triple_click':
        return this.doClick(id, a, 'left', 3)
      case 'right_click':
        return this.doClick(id, a, 'right', 1)
      case 'middle_click':
        return this.doClick(id, a, 'middle', 1)
      case 'mouse_move': {
        const [x, y] = this.point(id, a.coordinate)
        return this.deps.input.move(x, y)
      }
      case 'left_click_drag':
        return this.doDrag(id, a)
      case 'scroll':
        return this.doScroll(id, a)
      case 'type':
        return this.doType(id, a)
      case 'key':
        return this.doKey(id, a)
      case 'hold_key':
        return this.doHold(id, a)
      case 'wait':
        return sleep(clamp(Number(a.duration) || 1, 0.1, 30) * 1000)
      default:
        throw new Error(`不支持的操作：${String(a.action)}`)
    }
  }

  // ---- actions --------------------------------------------------------------

  private async doClick(id: string, a: Args, button: MouseButton, count: number): Promise<void> {
    const [x, y] = this.point(id, a.coordinate)
    const app = await this.check(id, 'click', [x, y])
    const mods = String(a.text ?? '')
      .split('+')
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean)
    const label = count === 2 ? tk('双击') : count === 3 ? tk('三击') : button === 'right' ? tk('右键点击') : tk('点击')
    this.deps.onAction?.(id, `${t(label)} ${app.name}`)
    await this.deps.input.click(x, y, button, count, mods)
  }

  private async doDrag(id: string, a: Args): Promise<void> {
    const [x1, y1] = this.point(id, a.start_coordinate)
    const [x2, y2] = this.point(id, a.coordinate)
    const app = await this.check(id, 'click', [x1, y1])
    await this.check(id, 'click', [x2, y2])
    this.deps.onAction?.(id, t('拖动 {0}', app.name))
    await this.deps.input.drag(x1, y1, x2, y2)
  }

  private async doScroll(id: string, a: Args): Promise<void> {
    const [x, y] = this.point(id, a.coordinate)
    const app = await this.check(id, 'click', [x, y])
    const n = Math.round(clamp(Number(a.scroll_amount) || 3, 1, 30))
    const d = String(a.scroll_direction ?? 'down')
    this.deps.onAction?.(id, t('滚动 {0}', app.name))
    await this.deps.input.scroll(x, y, d === 'left' ? -n : d === 'right' ? n : 0, d === 'up' ? -n : d === 'down' ? n : 0)
  }

  private async doType(id: string, a: Args): Promise<void> {
    const text = String(a.text ?? '')
    if (!text) throw new Error('text 不能为空')
    const app = await this.check(id, 'full')
    this.deps.onAction?.(id, t('向 {0} 输入', app.name))
    const cb = this.deps.clipboard
    if (this.deps.pasteChord && cb && /[^\x00-\x7f]/.test(text)) {
      const saved = await cb.read()
      await cb.write(text)
      await this.deps.input.key(this.deps.pasteChord)
      await sleep(300)
      await cb.write(saved)
    } else await this.deps.input.type(text)
  }

  private async doKey(id: string, a: Args): Promise<void> {
    const keys = String(a.text ?? a.keys ?? '').trim()
    if (!keys) throw new Error('text 不能为空')
    const app = await this.check(id, 'full')
    this.deps.onAction?.(id, t('向 {0} 发送 {1}', app.name, keys))
    await this.deps.input.key(keys, Math.round(clamp(Number(a.repeat) || 1, 1, 100)))
  }

  private async doHold(id: string, a: Args): Promise<void> {
    const keys = String(a.text ?? '').trim()
    if (!keys) throw new Error('text 不能为空')
    const app = await this.check(id, 'full')
    this.deps.onAction?.(id, t('向 {0} 按住 {1}', app.name, keys))
    await this.deps.input.holdKey(keys, clamp(Number(a.duration) || 1, 0.05, 10) * 1000)
  }

  // ---- access ---------------------------------------------------------------

  private ensureUsable(conversationId: string): void {
    if (!this.deps.enabled())
      throw new Error('用户没有开启电脑操控。如果确实需要，请用户在 设置 → 通用 → 允许操控电脑 里打开。')
  }

  private session(id: string): Session {
    let s = this.sessions.get(id)
    if (!s) this.sessions.set(id, (s = { grants: [], until: 0 }))
    return s
  }

  private async requestAccess(id: string, a: Args): Promise<string> {
    if (this.denied.has(id)) throw new Error('用户这次没有允许操控电脑。不要再试，直接告诉用户需要什么。')
    const names = (Array.isArray(a.apps) ? a.apps : [a.apps]).map((x) => String(x ?? '').trim()).filter(Boolean)
    if (!names.length) throw new Error('apps 不能为空')
    if (names.length > 12) throw new Error('一次最多申请 12 个程序')
    const problem = await this.deps.input.unavailable()
    if (problem) throw new Error(problem)
    if (this.deps.unattended?.(id))
      throw new Error('这是无人值守的任务，没有人能批准操控电脑，所以不能操控。请改用其他方式完成，或者告诉用户需要在场时再做。')

    let running: AppRef[] = []
    try {
      running = (await this.deps.input.apps()).filter((r) => !this.deps.isOwnApp?.(r))
    } catch {
      /* resolve by name only */
    }
    const already = this.granted(id)
    const wanted: AccessRequest['apps'] = []
    for (const n of names) {
      const q = norm(n)
      const hit =
        running.find((r) => norm(r.id) === q || norm(r.name) === q) ?? running.find((r) => norm(r.name).includes(q) || q.includes(norm(r.name)))
      const key = hit ? norm(hit.id) : q
      // Fenn Code itself is never controlled, so it isn't offered either.
      if (!hit && this.deps.isOwnApp?.({ id: q, name: n })) continue
      if (wanted.some((w) => w.key === key)) continue
      const name = hit?.name ?? n
      if (already.some((g) => g.key === key)) continue
      wanted.push({ key, name, tier: defaultTier({ key, name }), running: !!hit })
    }
    if (!wanted.length) return this.grantSummary(id, '这些程序已经被允许。')

    let settled = this.asking.get(id)
    if (!settled) {
      this.deps.onAsking?.(id, true)
      settled = this.deps.askAccess(id, { reason: String(a.reason ?? '').slice(0, 300), apps: wanted })
        .finally(() => {
          this.asking.delete(id)
          this.deps.onAsking?.(id, false)
        })
        // Applied when the user answers, even after this call has returned (see below).
        .then((answer) => this.applyAnswer(id, wanted, answer))
      settled.catch(() => {})
      this.asking.set(id, settled)
    }
    // Agents give a tool call a deadline (Antigravity: 3 minutes, counting the time the user takes), so the
    // call returns before it while the card stays up; asking again gets the answer.
    let timer: NodeJS.Timeout | undefined
    const later = new Promise<string>((resolve) => {
      timer = setTimeout(
        () => resolve('用户还没有回答（卡片还在 Fenn Code 里等着）。稍等一会儿，再用同样的参数调用 computer_request_access 就能拿到结果；不要改用别的办法操控电脑。'),
        this.deps.answerWaitMs ?? ANSWER_WAIT_MS
      )
    })
    try {
      return await Promise.race([settled, later])
    } finally {
      clearTimeout(timer)
    }
  }

  private applyAnswer(id: string, wanted: AccessRequest['apps'], answer: Record<string, TierChoice> | null): string {
    if (!answer) {
      this.denied.add(id)
      throw new Error('用户没有允许（或没有回应）操控电脑。不要再试，直接告诉用户需要什么。')
    }
    const s = this.session(id)
    if (s.until <= Date.now()) s.grants = []
    for (const w of wanted) {
      const t = answer[w.key] ?? w.tier
      if (t === 'none') continue
      s.grants = s.grants.filter((g) => g.key !== w.key)
      s.grants.push({ key: w.key, name: w.name, tier: t })
    }
    if (!s.grants.length) {
      this.denied.add(id)
      throw new Error('用户没有允许任何程序。不要再试，直接告诉用户需要什么。')
    }
    s.until = Date.now() + GRANT_IDLE_MS
    this.activate(id)
    const refused = wanted.filter((w) => answer[w.key] === 'none').map((w) => w.name)
    return this.grantSummary(id, refused.length ? `用户没有允许：${refused.join('、')}。` : '')
  }

  private grantSummary(id: string, lead: string): string {
    const lines = this.granted(id).map((g) => `- ${g.name}：${TIER_LABEL[g.tier]}`)
    return `${lead}现在允许的程序：\n${lines.join('\n')}\n先调用 computer_screenshot 看看屏幕。完全控制可以点击和输入；仅点击不能输入文字或按键；仅查看只能截图。`
  }

  /** Any action: needs an unexpired grant. */
  /**
   * The clipboard is shared by every app, and may hold a password just copied
   * from an app the agent may only look at. Using it takes an app with full
   * control, and reading it is refused while any view-only app is allowed.
   */
  private clipboardAllowed(id: string, verb: string): void {
    const g = this.granted(id)
    if (!g.some((x) => x.tier === 'full'))
      throw new Error(`${verb}剪贴板需要至少一个程序是「完全控制」。现在允许的程序都不能输入，所以也不能用剪贴板。`)
    const view = g.filter((x) => x.tier === 'view')
    if (verb === '读取' && view.length)
      throw new Error(`「${view.map((x) => x.name).join('、')}」只允许查看，剪贴板里可能是从它复制的内容，所以不能读取剪贴板。`)
  }

  private async gate(id: string): Promise<void> {
    if (this.denied.has(id)) throw new Error('用户这次没有允许操控电脑。不要再试，直接告诉用户需要什么。')
    const s = this.sessions.get(id)
    if (!s || !s.grants.length || s.until <= Date.now()) {
      if (s) s.grants = []
      throw new Error('还没有被允许操作任何程序。先调用 computer_request_access 列出要操作的程序。')
    }
    s.until = Date.now() + GRANT_IDLE_MS
    this.activate(id)
  }

  private match(id: string, app: AppRef): Grant | undefined {
    return this.findGrant(id, app)
  }

  private findGrant(id: string, app: { id: string; name: string }): Grant | undefined {
    const keys = [norm(app.id), norm(app.name)]
    return this.granted(id).find((g) => keys.includes(g.key) || keys.includes(norm(g.name)))
  }

  /** Checks the app under the point (clicks) or with focus (typing) allows `need`. */
  private async check(id: string, need: 'click' | 'full', at?: [number, number]): Promise<AppRef> {
    let app: AppRef | undefined
    try {
      app = at ? await this.deps.input.appAt(at[0], at[1]) : await this.deps.input.frontmost()
    } catch {
      app = undefined
    }
    if (!app)
      throw new Error(
        at
          ? '无法确认这个位置是哪个程序，为安全起见没有操作。可以先用 computer_open_application 把程序切到前台。'
          : '无法确认哪个程序在前台，为安全起见没有输入。先用 computer_open_application 或点击把要输入的程序切到前台。'
      )
    if (this.deps.isOwnApp?.(app)) throw new Error('这是 Fenn Code 自己的窗口，不能操作。')
    const g = this.match(id, app)
    if (!g)
      throw new Error(
        at
          ? `这个位置是「${app.name}」，它不在允许的程序里。需要的话先用 computer_request_access 申请。`
          : `现在前台是「${app.name}」，它不在允许的程序里。先切到被允许的程序，或用 computer_request_access 申请。`
      )
    if (RANK[g.tier] < RANK[need])
      throw new Error(
        g.tier === 'view'
          ? `「${g.name}」只允许查看，不能点击或输入。`
          : `「${g.name}」只允许点击，不能输入文字或按键。需要的话请用户在申请时选「完全控制」。`
      )
    return app
  }

  private activate(conversationId: string): void {
    if (this.active.has(conversationId)) return
    this.active.add(conversationId)
    this.deps.onActive?.(conversationId, true)
  }

  // ---- screen ---------------------------------------------------------------

  private display(id: string): DisplayInfo {
    const list = this.deps.screen.displays()
    if (!list.length) throw new Error('找不到显示器。')
    const want = this.sessions.get(id)?.display
    return list.find((d) => d.id === want) ?? list.find((d) => d.primary) ?? list[0]
  }

  private async screenshot(conversationId: string, lead = ''): Promise<ToolContent> {
    const d = this.display(conversationId)
    const region = { x: 0, y: 0, width: d.bounds.width, height: d.bounds.height }
    const s = await this.deps.screen.capture(d.id, MAX_WIDTH, MAX_HEIGHT, region)
    const session = this.session(conversationId)
    // The first screenshot says what to do if the model can't see it: no app-side guess about which models can.
    const blind = session.geometry ? '' : '如果你看不到这张图片，说明当前模型不能看图片：不要再操作，告诉用户换一个能看图片的模型。'
    session.geometry = { display: d.id, region, width: s.width, height: s.height }
    let front = ''
    try {
      const f = await this.deps.input.frontmost()
      if (f && !this.deps.isOwnApp?.(f)) front = `前台程序：${f.name}${this.match(conversationId, f) ? '' : '（未允许）'}。`
    } catch {
      /* optional */
    }
    const many = this.deps.screen.displays().length > 1 ? `显示器：${d.name}（共 ${this.deps.screen.displays().length} 个，可用 computer_switch_display 切换）。` : ''
    return new ToolContent([
      { type: 'text', text: `${lead}截图 ${s.width}×${s.height} 像素，坐标以此为准。${many}${front}${blind}` },
      { type: 'image', data: s.data, mimeType: 'image/png' }
    ])
  }

  private async zoom(id: string, region: unknown): Promise<ToolContent> {
    const g = this.session(id).geometry
    if (!g) throw new Error('请先调用 computer_screenshot 看一下屏幕。')
    const r = Array.isArray(region) ? region.map(Number) : []
    if (r.length !== 4 || r.some((v) => !Number.isFinite(v))) throw new Error('region 要写成 [x0, y0, x1, y1]')
    const [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
    if (x1 - x0 < 4 || y1 - y0 < 4) throw new Error('区域太小')
    const sx = g.region.width / g.width
    const sy = g.region.height / g.height
    const crop = {
      x: g.region.x + clamp(x0, 0, g.width) * sx,
      y: g.region.y + clamp(y0, 0, g.height) * sy,
      width: (clamp(x1, 0, g.width) - clamp(x0, 0, g.width)) * sx,
      height: (clamp(y1, 0, g.height) - clamp(y0, 0, g.height)) * sy
    }
    const s = await this.deps.screen.capture(g.display, MAX_WIDTH, MAX_HEIGHT, crop)
    return new ToolContent([
      { type: 'text', text: `放大的区域 [${x0}, ${y0}, ${x1}, ${y1}]。点击时仍按完整截图的坐标。` },
      { type: 'image', data: s.data, mimeType: 'image/png' }
    ])
  }

  /** Screenshot pixels → desktop points. */
  private point(id: string, c: unknown): [number, number] {
    const g = this.sessions.get(id)?.geometry
    if (!g) throw new Error('请先调用 computer_screenshot 看一下屏幕。')
    const v = Array.isArray(c) ? c.map(Number) : []
    if (v.length !== 2 || !v.every(Number.isFinite)) throw new Error('coordinate 要写成 [x, y]')
    const d = this.deps.screen.displays().find((x) => x.id === g.display)
    if (!d) throw new Error('显示器已断开，请重新截图。')
    const x = d.bounds.x + g.region.x + clamp(v[0], 0, g.width - 1) * (g.region.width / g.width)
    const y = d.bounds.y + g.region.y + clamp(v[1], 0, g.height - 1) * (g.region.height / g.height)
    return [Math.round(x), Math.round(y)]
  }

  /** Desktop points → screenshot pixels. */
  private fromScreen(id: string, x: number, y: number): [number, number] {
    const g = this.sessions.get(id)?.geometry
    const d = g && this.deps.screen.displays().find((v) => v.id === g.display)
    if (!g || !d) return [Math.round(x), Math.round(y)]
    return [Math.round(((x - d.bounds.x - g.region.x) * g.width) / g.region.width), Math.round(((y - d.bounds.y - g.region.y) * g.height) / g.region.height)]
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
