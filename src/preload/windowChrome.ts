import { ipcRenderer } from 'electron'

/** Native window chrome belongs to the shell, independently of conversation state. */
export function installWindowChrome(): void {
  let fullscreen = false
  let receivedEvent = false
  const apply = () => document.documentElement?.classList.toggle('window-fullscreen', fullscreen)
  ipcRenderer.on('oc:window-state', (_event, state: { fullscreen: boolean }) => {
    receivedEvent = true
    fullscreen = state.fullscreen
    apply()
  })
  // A state change while this request is in flight wins over its older reply.
  void ipcRenderer.invoke('oc:window-state').then((state: { fullscreen: boolean }) => {
    if (receivedEvent) return
    fullscreen = state.fullscreen
    apply()
  }).catch(error => console.warn('Could not read native window state:', error))
  document.addEventListener('DOMContentLoaded', apply, { once: true })
}
