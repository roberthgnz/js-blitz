// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import started from 'electron-squirrel-startup'

import { executeCode, type ExecuteCodeRequest } from '../lib/coderunner'

if (started) {
  app.quit()
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    // frame: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    )
  }

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools()
  }
}

ipcMain.handle('execute-code', async (_, request: ExecuteCodeRequest) => {
  try {
    return await executeCode(request)
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
})

app.on('ready', createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
