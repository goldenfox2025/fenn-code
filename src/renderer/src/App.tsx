import { useEffect } from 'react'
import { CircleAlert, PanelLeft, X } from 'lucide-react'
import { Dialogs } from './components/Dialogs'
import { DotField } from './components/DotField'
import { ConfirmHost } from './components/Modal'
import { DeleteItemsHost } from './components/DeleteItemsDialog'
import { TooltipLayer } from './components/Tooltip'
import { Onboarding } from './components/Onboarding'
import { RightSurfaces } from './components/RightSurfaces'
import { WindowButtons } from './components/WindowButtons'
import { AccountQuota } from './components/AccountQuota'
import { usePaneFit } from './components/ResizeHandle'
import { Sidebar } from './components/Sidebar'
import { api, dismissToast, toast, useApp } from './store'
import { langSetting, setLanguage, t } from './i18n'
import { ChatView } from './views/ChatView'
import { HomeView } from './views/HomeView'
import { ChatsPage, ProjectsPage, RoutinesPage } from './views/Pages'
import { ProjectView } from './views/ProjectView'

export function App() {
  const ready = useApp((s) => s.ready)
  const route = useApp((s) => s.route)
  const theme = useApp((s) => s.settings.theme)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  usePaneFit(sidebarOpen)
  const platform = useApp((s) => s.platform)
  const toasts = useApp((s) => s.toasts)
  const dotGrid = useApp((s) => s.settings.dotGrid ?? 1)
  // Shown until the guide is finished or skipped, so leaving it half-way brings it back next time.
  const firstRun = useApp((s) => !s.settings.onboarded)

  useTheme(theme)
  useShortcuts()
  useReenterNotice()
  useLanguageSync()

  if (!ready) return null

  let view: React.ReactNode
  switch (route.view) {
    case 'home':
      view = <HomeView key={route.folder ?? ''} folder={route.folder} />
      break
    case 'chat':
      view = <ChatView conversationId={route.conversationId} />
      break
    case 'project':
      view = <ProjectView key={route.projectId} projectId={route.projectId} threadId={route.threadId} overview={route.overview} />
      break
    case 'projects':
      view = <ProjectsPage />
      break
    case 'chats':
      view = <ChatsPage />
      break
    case 'routines':
      view = <RoutinesPage />
      break
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {!!dotGrid && <DotField strength={dotGrid} />}
        <div className="topbar drag">
          {!sidebarOpen && (
            <button
              className="icon-btn sidebar-toggle"
              aria-label={t('打开侧栏')}
              onClick={() => useApp.getState().set({ sidebarOpen: true })}
            >
              <PanelLeft size={17} />
            </button>
          )}
          <span className="spacer" />
          <AccountQuota />
          {platform !== 'darwin' && <WindowControls />}
        </div>
        <div className="workspace">
          <div className="center">{view}</div>
          <RightSurfaces conversationId={route.view === 'chat' ? route.conversationId : undefined} />
        </div>
      </main>
      <Dialogs />
      <ConfirmHost />
      <DeleteItemsHost />
      <TooltipLayer />
      {firstRun && <Onboarding />}
      <div className="toasts">
        {toasts.map((n) => (
          <div key={n.id} className={'toast ' + n.level} role={n.level === 'error' ? 'alert' : 'status'}>
            {n.level === 'error' && <CircleAlert className="toast-icon" size={15} />}
            <span className="toast-text">{n.text}</span>
            <button className="toast-close" aria-label={t('关闭')} onClick={() => dismissToast(n.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function WindowControls() {
  return <WindowButtons onAction={action => api().windowControl(action)} />
}

/** The page follows the chosen color scheme, including OS changes in system mode. */
function useTheme(theme: 'system' | 'light' | 'dark') {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const root = document.documentElement
    const look = () => theme === 'dark' || (theme === 'system' && mq.matches) ? 'dark' : 'light'
    const set = () => { root.dataset.theme = look() }
    const apply = () => {
      const fade = !!root.dataset.theme && root.dataset.theme !== look() && 'startViewTransition' in document &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!fade) return set()
      const transition = (document as Document & { startViewTransition(cb: () => void): { ready: Promise<void>; finished: Promise<void> } }).startViewTransition(set)
      transition.ready.catch(() => undefined)
      transition.finished.catch(() => undefined)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

/** Once per launch: secrets the rename couldn't carry over need entering again. */
let reenterShown = false
function useReenterNotice() {
  const n = useApp((s) => s.settings.secretsToReenter?.length ?? 0)
  useEffect(() => {
    if (!n || reenterShown) return
    reenterShown = true
    toast(t('有 {0} 个密钥需要重新填写，详见设置。', n))
  }, [n])
}

/**
 * The language lives in settings (the main process uses it too) and is cached
 * locally for the first paint: keep the two the same.
 */
function useLanguageSync() {
  const saved = useApp((s) => (s.ready ? (s.settings.language ?? null) : undefined))
  useEffect(() => {
    if (saved === undefined) return
    if (saved === null) void api().updateSettings({ language: langSetting })
    else if (saved !== langSetting) void setLanguage(saved)
  }, [saved])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const s = useApp.getState()
      // The first-run guide covers the app; nothing behind it should open or move.
      if (!s.settings.onboarded) return
      if (e.key === 'b') {
        e.preventDefault()
        s.set({ sidebarOpen: !s.sidebarOpen })
      } else if (e.key === 'n' || (e.shiftKey && e.key === 'O')) {
        e.preventDefault()
        s.navigate({ view: 'home' })
      } else if (e.key === ',') {
        e.preventDefault()
        s.set({ settingsOpen: 'general' })
      } else if (e.key === 'k') {
        e.preventDefault()
        s.set({ sidebarOpen: true })
        document.querySelector<HTMLInputElement>('.search input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

