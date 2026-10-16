/**
 * Mouse, keyboard and app lookup for computer control, without native
 * modules: each platform drives its own built-in tooling.
 *
 *   Windows  one long-lived PowerShell process calling user32 (SendInput)
 *   macOS    JavaScript for Automation (CoreGraphics events, System Events);
 *            needs Accessibility permission for Ancora
 *   Linux    xdotool (X11; Wayland sessions don't allow synthetic input)
 *
 * Coordinates given to a driver are logical screen points (Electron's DIP
 * space across all displays); each driver converts them to what its platform
 * wants.
 */
import { join } from 'node:path'
import { LinuxDriverImpl } from './linux'
import { MacDriverImpl } from './mac'
import { spawnWinHost, WindowsDriverImpl } from './win'

export { parseChord, MODIFIERS } from './proc'

export type MouseButton = 'left' | 'right' | 'middle'

/** A running application, as the platform names it. */
export interface AppRef {
  /** Stable id: the executable name on Windows and Linux, the bundle id on macOS. */
  id: string
  /** What people call it ("Notepad", "Safari"). */
  name: string
  pid?: number
}

export interface InputDriver {
  readonly name: string
  /** Why input can't work here, if it can't (shown to the agent and the user). */
  unavailable(): Promise<string | undefined>
  click(x: number, y: number, button: MouseButton, count: number, mods?: string[]): Promise<void>
  move(x: number, y: number): Promise<void>
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  type(text: string): Promise<void>
  /** A key or chord such as "enter", "ctrl+c", "cmd+shift+t". */
  key(chord: string, repeat?: number): Promise<void>
  /** Holds a key or chord down for a while, then releases it. */
  holdKey(chord: string, ms: number): Promise<void>
  /** Where the pointer is, in logical points. */
  cursor(): Promise<{ x: number; y: number }>
  /** The app whose window has keyboard focus. */
  frontmost(): Promise<AppRef | undefined>
  /** The app whose window is at this point (what a click there would hit). */
  appAt(x: number, y: number): Promise<AppRef | undefined>
  /** Apps that have a visible window. */
  apps(): Promise<AppRef[]>
  /** Brings an app to the front, starting it if needed. Resolves with what came to the front. */
  open(name: string): Promise<AppRef | undefined>
  /** Stops any helper process. */
  dispose?(): void
}

/** Converts between logical points and the coordinates the platform's input API uses. */
export interface Coords {
  toDevice(x: number, y: number): [number, number]
  fromDevice(x: number, y: number): [number, number]
}

export function inputDriver(platform: NodeJS.Platform, coords: Coords, resourcesDir: string): InputDriver {
  if (platform === 'darwin') return new MacDriverImpl()
  if (platform === 'win32') return new WindowsDriverImpl(coords, () => spawnWinHost(join(resourcesDir, 'win-input.ps1')))
  return new LinuxDriverImpl(coords)
}
