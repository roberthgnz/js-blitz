// eslint-disable-next-line @typescript-eslint/ban-ts-comment

import fs from 'fs/promises'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
// @ts-ignore
import started from 'electron-squirrel-startup'
import { updateElectronApp } from 'update-electron-app'

import { executeCode, type ExecuteCodeRequest } from '../lib/coderunner'

if (started) {
  app.quit()
}

updateElectronApp({
  repo: 'roberthgnz/js-blitz',
  updateInterval: '1 day',
})

const userDataPath = app.isPackaged
  ? path.resolve(app.getPath('userData'))
  : path.resolve(__dirname, '..', '..', 'temp')
const stateFilePath = path.join(userDataPath, 'window-state.json')

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

const loadWindowState = async () => {
  try {
    const content = await fs.readFile(stateFilePath, 'utf-8')
    return JSON.parse(content)
  } catch (e) {
    return {
      width: 800,
      height: 600,
      x: undefined,
      y: undefined,
    }
  }
}

const saveWindowState = (window: BrowserWindow) => {
  if (!window.isMaximized()) {
    const bounds = window.getBounds()
    try {
      fs.writeFile(stateFilePath, JSON.stringify(bounds))
    } catch (e) {
      console.error('Failed to save window state', e)
    }
  }
}

const createWindow = async () => {
  const state = await loadWindowState()

  const mainWindow = new BrowserWindow({
    // frame: false,
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.on('resize', () => saveWindowState(mainWindow))
  mainWindow.on('moved', () => saveWindowState(mainWindow))

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
