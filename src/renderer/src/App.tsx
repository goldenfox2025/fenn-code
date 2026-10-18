import { useEffect } from 'react'
import { CircleAlert, Minus, Orbit, PanelLeft, Square, X } from 'lucide-react'
import { Dialogs } from './components/Dialogs'
import { ConfirmHost } from './components/Modal'
import { TooltipLayer } from './components/Tooltip'
import { Onboarding } from './components/Onboarding'
import { PagePanel } from './components/PagePanel'
import { FileViewPanel } from './components/FileViewPanel'
import { ChatSidePane } from './components/SidePane'
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
  const glass = useApp((s) => !!s.settings.glass)
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  usePaneFit(sidebarOpen)
  const page = useApp((s) => s.page)
  const fileView = useApp((s) => s.fileView)
  const platform = useApp((s) => s.platform)
  const toasts = useApp((s) => s.toasts)
  // Shown until the guide is finished or skipped, so leaving it half-way brings it back next time.
  const firstRun = useApp((s) => !s.settings.onboarded)

  useTheme(theme, glass)
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
      view = <ProjectView projectId={route.projectId} threadId={route.threadId} overview={route.overview} />
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
        <div className="topbar drag">
          {!sidebarOpen && (
            <button
              className="icon-btn"
              style={platform === 'darwin' ? { marginLeft: 70 } : undefined}
              onClick={() => useApp.getState().set({ sidebarOpen: true })}
            >
              <PanelLeft size={17} />
            </button>
          )}
          <span className="spacer" />
          <GlassToggle />
          {platform !== 'darwin' && <WindowControls />}
        </div>
        <div className="workspace">
          <div className="center">{view}</div>
          {page ? <PagePanel id={page.id} version={page.version} /> : fileView ? <FileViewPanel path={fileView.path} conversationId={fileView.conversationId} /> : route.view === 'chat' && <ChatSidePane conversationId={route.conversationId} />}
        </div>
      </main>
      <Dialogs />
      <ConfirmHost />
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
  return (
    <div className="winctl">
      <button onClick={() => api().windowControl('minimize')}>
        <Minus size={15} />
      </button>
      <button onClick={() => api().windowControl('maximize')}>
        <Square size={12} />
      </button>
      <button className="close" onClick={() => api().windowControl('close')}>
        <X size={16} />
      </button>
    </div>
  )
}

/** One click to turn the glass look on or off, over whichever color scheme is set. */
function GlassToggle() {
  const on = useApp((s) => !!s.settings.glass)
  const toggle = () => void api().updateSettings({ glass: !on })
  return (
    <button className={'icon-btn glass-toggle' + (on ? ' on' : '')} data-tip={on ? t('退出玻璃效果') : t('玻璃效果')} aria-pressed={on} onClick={toggle}>
      <Orbit size={16} />
    </button>
  )
}

let nativeGlass: boolean | undefined
let softwareRendering = false

function useTheme(theme: 'system' | 'light' | 'dark' | 'glass', glass: boolean) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const root = document.documentElement
    const look = () => {
      const dark = theme === 'dark' || theme === 'glass' || (theme === 'system' && mq.matches)
      // Glass over dark keeps its old name, 'glass'; glass over light is 'glass-light'.
      return glass ? (dark ? 'glass' : 'glass-light') : dark ? 'dark' : 'light'
    }
    const set = () => {
      root.dataset.theme = look()
      root.classList.toggle('native-glass', glass && !!nativeGlass)
      root.classList.toggle('no-blur', softwareRendering)
    }
    // A change of look cross-fades instead of snapping. The window's own material changes
    // behind the page, timed by the main process so it never shows (see applyWindowMaterial).
    const apply = () => {
      const fade = !!root.dataset.theme && root.dataset.theme !== look() && 'startViewTransition' in document &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!fade) return set()
      // A fade cut short by the next change (or skipped) rejects these; the look is set either way.
      const fadeOut = (document as Document & { startViewTransition(cb: () => void): { ready: Promise<void>; finished: Promise<void> } }).startViewTransition(set)
      fadeOut.ready.catch(() => undefined)
      fadeOut.finished.catch(() => undefined)
    }
    if (nativeGlass === undefined)
      void api()
        .appInfo()
        .then((i) => {
          nativeGlass = !!i.nativeGlass
          softwareRendering = !!i.softwareRendering
          apply()
        })
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, glass])
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

