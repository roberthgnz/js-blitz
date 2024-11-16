// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron'

import type { ExecuteCodeRequest, ExecuteResponse } from './lib/coderunner'

declare global {
  interface Window {
    electronAPI: {
      executeCode: (request: ExecuteCodeRequest) => Promise<ExecuteResponse>
      onPackageInstallationStarted: (callback: (...args: any[]) => void) => void
      onPackageInstallationFinished: (
        callback: (...args: any[]) => void
      ) => void
      minimizeWindow: () => void
      maximizeWindow: () => void
      closeWindow: () => void
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  executeCode: (code: string) => ipcRenderer.invoke('execute-code', code),
  onPackageInstallationStarted: (callback: (...args: any[]) => void) =>
    ipcRenderer.on('package-installation-started', (_event, ...args) =>
      callback(...args)
    ),
  onPackageInstallationFinished: (callback: (...args: any[]) => void) =>
    ipcRenderer.on('package-installation-finished', (_event, ...args) =>
      callback(...args)
    ),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
})
