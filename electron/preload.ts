import { contextBridge, ipcRenderer } from 'electron'

import type { ElectronAPI } from '../types'

const events = new Set([
  'set-theme',
  'execution-output',
  'package-installation-started',
  'package-installation-finished',
  'code-execution-started',
  'code-execution-finished',
])
const api: ElectronAPI = {
  on(event, callback) {
    if (!events.has(event)) throw new Error('Unsupported event: ' + event)
    const listener = (_event: Electron.IpcRendererEvent, ...args: any[]) =>
      callback(...args)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  },
  executeCode: (request) => ipcRenderer.invoke('execute-code', request),
  cancelExecution: (runId) => ipcRenderer.invoke('cancel-execution', runId),
  listPackages: () => ipcRenderer.invoke('list-packages'),
  installPackage: (name) => ipcRenderer.invoke('install-package', name),
  getTypeDefinitions: () => ipcRenderer.invoke('get-type-definitions'),
  getDesktopSettings: () => ipcRenderer.invoke('get-desktop-settings'),
  saveDesktopSettings: (settings) =>
    ipcRenderer.invoke('save-desktop-settings', settings),
  askAssistant: (request) => ipcRenderer.invoke('ask-assistant', request),
  cancelAssistant: (requestId) =>
    ipcRenderer.invoke('cancel-assistant', requestId),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
}
contextBridge.exposeInMainWorld('electronAPI', api)
window.addEventListener('DOMContentLoaded', () => {
  document.body.style.backgroundColor =
    localStorage.getItem('js-blitz-bg-color') || '#282a36'
})
