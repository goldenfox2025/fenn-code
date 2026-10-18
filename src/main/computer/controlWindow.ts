/** The parts of Fenn Code's main window that computer control moves out of the way. */
export interface WindowLike {
  isVisible(): boolean
  isMinimized(): boolean
  hide(): void
  minimize(): void
  restore(): void
  show(): void
  showInactive(): void
  focus(): void
}

/**
 * Where the main window is while agents control the computer: out of the way (so an agent
 * doesn't act on it) while any conversation is in control, but back in front while one asks
 * the user for access, since that question is a card in the window. Once no conversation
 * asks, it steps aside again if control goes on, or comes back when control ends.
 */
export class ControlWindow {
  private controlling = new Set<string>()
  private asking = new Set<string>()
  /** The window was moved out of the way for control (not by the user), so it comes back after. */
  private stepped = false

  constructor(
    private readonly win: () => WindowLike | null | undefined,
    private readonly platform: NodeJS.Platform
  ) {}

  get active(): boolean {
    return this.controlling.size > 0
  }

  setActive(conversationId: string, on: boolean): void {
    if (on) this.controlling.add(conversationId)
    else this.controlling.delete(conversationId)
    this.apply()
  }

  setAsking(conversationId: string, on: boolean): void {
    if (on) this.asking.add(conversationId)
    else this.asking.delete(conversationId)
    this.apply()
  }

  private apply(): void {
    const w = this.win()
    if (!w) return
    if (this.asking.size) {
      if (w.isMinimized()) w.restore()
      if (!w.isVisible()) w.show()
      w.focus()
      return
    }
    if (this.controlling.size) {
      if (w.isVisible() && !w.isMinimized()) {
        // Linux window managers vary (and some can't minimize at all), so hide there.
        if (this.platform === 'linux') w.hide()
        else w.minimize()
        this.stepped = true
      }
      return
    }
    if (!this.stepped) return
    this.stepped = false
    if (w.isMinimized()) w.restore()
    else if (!w.isVisible()) w.showInactive()
  }
}
