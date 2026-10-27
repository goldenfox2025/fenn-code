import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { errorText } from '../shared/errors'
import { API_METHODS } from '../shared/ipc'
import type { AppEvent, FennApi } from '../shared/model'
import { installWindowChrome } from './windowChrome'

installWindowChrome()

const api = Object.fromEntries(
  // A failure arrives as the core's own message, without Electron's "Error invoking remote method" wrapper.
  API_METHODS.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`oc:${name}`, ...args).catch((e: unknown) => { throw new Error(errorText(e)) })])
) as Record<(typeof API_METHODS)[number], unknown>

contextBridge.exposeInMainWorld('fenn', {
  ...api,
  onEvent(listener: (e: AppEvent) => void) {
    const h = (_: unknown, e: AppEvent) => listener(e)
    ipcRenderer.on('oc:event', h)
    return () => ipcRenderer.removeListener('oc:event', h)
  },
  platform: process.platform,
  windowControl: (action: string) => ipcRenderer.send('oc:window', action)
} satisfies Record<keyof FennApi, unknown>)

// Where a dropped or picked file lives on disk, so the agent gets its real path ('' for a pasted image).
contextBridge.exposeInMainWorld('fennFilePath', (file: File): string => {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
})
