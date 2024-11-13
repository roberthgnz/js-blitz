// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
import { contextBridge, ipcRenderer } from 'electron'

import type { ExecuteCodeRequest, ExecuteResponse } from './lib/coderunner'

declare global {
  interface Window {
    electronAPI: {
      executeCode: (request: ExecuteCodeRequest) => Promise<ExecuteResponse>
      minimizeWindow: () => void
      maximizeWindow: () => void
      closeWindow: () => void
    }
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  executeCode: (code: string) => ipcRenderer.invoke('execute-code', code),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
})
