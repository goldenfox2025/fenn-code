import { useRef } from 'react'
import { useApp } from '../store'
import { BrowserPanel } from './BrowserPanel'
import { FileViewPanel } from './FileViewPanel'
import { PagePanels } from './PagePanel'
import { ChatSidePane } from './SidePane'
import { usePanePresence } from './usePanePresence'

/** One selected preview and one exit lifecycle; cached iframes never reparent. */
export function RightSurfaces({ conversationId }: { conversationId?: string }) {
  const browser = useApp(s => s.browserView), file = useApp(s => s.fileView), page = useApp(s => s.page)
  const selected = browser ? { kind: 'browser' as const, owner: browser } : page ? { kind: 'page' as const, page } : file ? { kind: 'file' as const, file } : null
  const last = useRef(selected)
  if (selected) last.current = selected
  const presence = usePanePresence(!!selected), shown = selected || (presence.present ? last.current : null)
  return <>
    <PagePanels selected={shown?.kind === 'page' ? shown.page : null} exiting={presence.exiting} />
    {shown?.kind === 'browser' ? <BrowserPanel key={shown.owner} ownerId={shown.owner} exiting={presence.exiting} /> : shown?.kind === 'file' ? <FileViewPanel {...shown.file} exiting={presence.exiting} /> : null}
    {conversationId && <ChatSidePane conversationId={conversationId} hidden={presence.present} />}
  </>
}
