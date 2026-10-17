import { contextBridge, ipcRenderer } from 'electron'
import { errorText } from '../shared/errors'
import { API_METHODS } from '../shared/ipc'
import type { AppEvent, AncoraApi } from '../shared/model'

const api = Object.fromEntries(
  // A failure arrives as the core's own message, without Electron's "Error invoking remote method" wrapper.
  API_METHODS.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`oc:${name}`, ...args).catch((e: unknown) => { throw new Error(errorText(e)) })])
) as Record<(typeof API_METHODS)[number], unknown>

contextBridge.exposeInMainWorld('ancora', {
  ...api,
  onEvent(listener: (e: AppEvent) => void) {
    const h = (_: unknown, e: AppEvent) => listener(e)
    ipcRenderer.on('oc:event', h)
    return () => ipcRenderer.removeListener('oc:event', h)
  },
  platform: process.platform,
  windowControl: (action: string) => ipcRenderer.send('oc:window', action)
} satisfies Record<keyof AncoraApi, unknown>)
