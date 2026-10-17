import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS } from '../shared/ipc'
import type { AppEvent, AncoraApi } from '../shared/model'

const api = Object.fromEntries(
  API_METHODS.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`oc:${name}`, ...args)])
) as Record<(typeof API_METHODS)[number], unknown>

contextBridge.exposeInMainWorld('ancora', {
  ...api,
  onEvent(listener: (e: AppEvent) => void) {
    const h = (_: unknown, e: AppEvent) => listener(e)
    ipcRenderer.on('oc:event', h)
    return () => ipcRenderer.removeListener('oc:event', h)
  },
  pickFolder: (start?: string) => ipcRenderer.invoke('oc:pickFolder', start),
  openConfigFolder: () => ipcRenderer.invoke('oc:openConfigFolder'),
  exportConversation: (id: string) => ipcRenderer.invoke('oc:exportConversation', id),
  platform: process.platform,
  windowControl: (action: string) => ipcRenderer.send('oc:window', action)
} satisfies Record<keyof AncoraApi, unknown>)
