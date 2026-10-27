export type BrowserMode = 'auto' | 'existing' | 'isolated'
export interface BrowserConfig { browserMode: BrowserMode; cdpUrl?: string }
export interface BrowserInfo { ownerId: string; url: string; title: string; mode: 'existing' | 'isolated'; active: boolean }
export interface BrowserFrame extends BrowserInfo { image?: string; mimeType?: string; stale?: boolean }
export interface BrowserViewService {
  info(id: string): Promise<BrowserInfo | null>
  frame(id: string): Promise<BrowserFrame | null>
  stop(id: string): Promise<void>
}
