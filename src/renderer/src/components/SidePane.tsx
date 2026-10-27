import { BackgroundPanel } from './background/BackgroundPanel'
import { useRunning } from './background/useBackgroundTasks'
export { useRunning } from './background/useBackgroundTasks'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@shared/model'
import { useApp } from '../store'
import { t } from '../i18n'
import { FilesPane, flushFileEdits } from './FilesPane'
import { PaneSizeButton, PreviewPane } from './PreviewPane'
import { usePanePresence } from './usePanePresence'
import { panelTabKeys } from './OverflowTabs'

/**
 * The pane beside a chat, as in Claude Code: the folder's files, and the work
 * running in the background (sub-conversations, commands the agent runs
 * through the app). It stays open from chat to chat until closed.
 */
export function ChatSidePane({ conversationId, hidden = false }: { conversationId: string; hidden?: boolean }) {
  const requested = useApp((s) => s.sidePane)
  const last = useRef<'files' | 'background'>('background')
  if (requested) last.current = requested === 'files' ? 'files' : 'background'
  const tab = last.current, presence = usePanePresence(!!requested)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { if (!presence.present || tab !== 'files') setExpanded(false) }, [presence.present, tab])
  const conv = useApp((s) => s.conversations.find((c) => c.id === conversationId))
  if (!presence.present || !conv) return null
  const set = (sidePane: 'files' | 'background' | null) => void flushFileEdits().then(ok => ok && useApp.getState().set({ sidePane }))
  return (
    <PreviewPane className={'side-pane' + (tab === 'background' ? ' background-side-pane' : '')} expanded={expanded && tab === 'files'} onCollapse={() => setExpanded(false)} hidden={hidden} exiting={presence.exiting} label={t('文件与后台')}>
      <div className="panel-head">
        <div className="tabs" role="tablist" aria-label={t('文件与后台')} onKeyDown={panelTabKeys}>
          <button role="tab" data-tab="files" aria-selected={tab === 'files'} className={'tab' + (tab === 'files' ? ' active' : '')} onClick={() => set('files')}>
            {t('文件')}
          </button>
          <button role="tab" data-tab="background" aria-selected={tab === 'background'} className={'tab' + (tab === 'background' ? ' active' : '')} onClick={() => set('background')}>
            {t('后台')}
            <RunningCount conv={conv} />
          </button>
        </div>
        <span className="spacer" />
        {tab === 'files' && <PaneSizeButton expanded={expanded} onToggle={() => setExpanded(value => !value)} />}
        <button className="icon-btn" data-tip={t('关闭')} aria-label={t('关闭')} onClick={() => set(null)}>
          <X size={16} />
        </button>
      </div>
      <div className="panel-body">{tab === 'files' ? <FilesPane key={conv.parentId ?? conv.id} id={conv.parentId ?? conv.id} /> : <BackgroundPanel key={conv.id} conv={conv} />}</div>
    </PreviewPane>
  )
}

function RunningCount({ conv }: { conv: Conversation }) {
  const n = useRunning(conv)
  return n ? <span className="tab-count">{n}</span> : null
}
