// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron'

import type { ExecuteCodeRequest, ExecuteResponse } from './lib/coderunner'

declare global {
  interface Window {
    electronAPI: {
      executeCode: (request: ExecuteCodeRequest) => Promise<ExecuteResponse>
      onInstallingPackages: (callback: (packages: string[]) => void) => void
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  executeCode: (code: string) => ipcRenderer.invoke('execute-code', code),
  onInstallingPackages: (callback: (packages: string[]) => void) =>
    ipcRenderer.on('installing-packages', (_, packages) => callback(packages)),
})
