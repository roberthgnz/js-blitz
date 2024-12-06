// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import type { ExecuteResponse } from '@/types/index'
import { contextBridge, ipcRenderer } from 'electron'

declare global {
  interface Window {
    electronAPI: {
      on: (event: string, callback: (...args: any[]) => void) => void
      executeCode: (code: string) => Promise<ExecuteResponse>
      minimizeWindow: () => void
      maximizeWindow: () => void
      closeWindow: () => void
      showContextMenu: () => void
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  on: (event: string, callback: (...args: any[]) => void) =>
    ipcRenderer.on(event, (_event, ...args) => callback(...args)),
  executeCode: (code: string) => ipcRenderer.invoke('execute-code', code),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
})

// Define a custom preload script that will be used to set the background color
window.addEventListener('DOMContentLoaded', () => {
  document.body.style.backgroundColor =
    window.localStorage.getItem('js-blitz-bg-color') || '#f8f9fa'
})
