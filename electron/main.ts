import fs from 'fs'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import started from 'electron-squirrel-startup'
import si from 'systeminformation'
import { updateElectronApp } from 'update-electron-app'

import { executeCode, type ExecuteCodeRequest } from './lib/coderunner'

if (started) {
  app.quit()
}

updateElectronApp({
  repo: 'roberthgnz/js-blitz',
  updateInterval: '1 hour',
})

const userDataPath = app.isPackaged
  ? path.resolve(app.getPath('userData'))
  : path.resolve(__dirname, '..', '..', 'temp')
const stateFilePath = path.join(userDataPath, 'window-state.json')

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

type WindowState = {
  width: number
  height: number
  x: number
  y: number
}

const defaultState: WindowState = {
  width: 800,
  height: 600,
  x: undefined,
  y: undefined,
}

const ensureWindowIsVisible = async (windowState: WindowState) => {
  try {
    const displays = await si.graphics()
    const monitors = displays.displays

    if (!monitors || monitors.length === 0) {
      return defaultState
    }

    let minX = 0,
      minY = 0,
      maxX = 0,
      maxY = 0
    monitors.forEach((display) => {
      const x = display.positionX
      const y = display.positionY
      const width = display.resolutionX
      const height = display.resolutionY

      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + width)
      maxY = Math.max(maxY, y + height)
    })

    windowState.width = Math.max(400, Math.min(windowState.width, maxX - minX))
    windowState.height = Math.max(
      300,
      Math.min(windowState.height, maxY - minY)
    )

    let isWindowVisible = false
    for (const display of monitors) {
      const x = display.positionX
      const y = display.positionY
      const width = display.resolutionX
      const height = display.resolutionY

      if (
        windowState.x >= x &&
        windowState.y >= y &&
        windowState.x + windowState.width <= x + width &&
        windowState.y + windowState.height <= y + height
      ) {
        isWindowVisible = true
        break
      }
    }

    if (!isWindowVisible) {
      const primaryDisplay = monitors[0]
      const width = primaryDisplay.resolutionX
      const height = primaryDisplay.resolutionY

      windowState.x = Math.round((width - windowState.width) / 2)
      windowState.y = Math.round((height - windowState.height) / 2)
    }

    return windowState
  } catch (error) {
    console.error(error)
    return defaultState
  }
}

const loadWindowState = async () => {
  try {
    let state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
    state = { ...defaultState, ...state }
    return await ensureWindowIsVisible(state)
  } catch (e) {
    try {
      const displays = await si.graphics()
      const primaryDisplay = displays.displays[0]
      const width = primaryDisplay.resolutionX
      const height = primaryDisplay.resolutionY

      return {
        ...defaultState,
        x: Math.round((width - defaultState.width) / 2),
        y: Math.round((height - defaultState.height) / 2),
      }
    } catch (error) {
      console.error(error)
      return defaultState
    }
  }
}

const saveWindowState = (window: BrowserWindow) => {
  if (!window.isMaximized() && !window.isMinimized()) {
    const bounds = window.getBounds()
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        ...bounds,
        isMaximized: false,
      })
    )
  }
}

const createWindow = async () => {
  const state = await loadWindowState()

  const mainWindow = new BrowserWindow({
    frame: false,
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: defaultState.width / 2,
    minHeight: defaultState.height / 2,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  })

  mainWindow.on('resize', () => saveWindowState(mainWindow))
  mainWindow.on('moved', () => saveWindowState(mainWindow))

  mainWindow.on('maximize', () => {
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({
        ...mainWindow.getBounds(),
        isMaximized: true,
      })
    )
  })

  mainWindow.on('unmaximize', () => {
    saveWindowState(mainWindow)
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

  try {
    const savedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'))
    if (savedState.isMaximized) {
      mainWindow.maximize()
    }
  } catch (error) {
    console.error(error)
  }
}

ipcMain.handle('execute-code', async (event, request: ExecuteCodeRequest) => {
  const webContents = event.sender
  try {
    return await executeCode(request, ({ status }) => {
      webContents.send(status)
    })
  } catch (error) {
    webContents.send('code-execution-finished')
    webContents.send('package-installation-finished')
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
})

ipcMain.on('minimize-window', () => {
  BrowserWindow.getFocusedWindow()?.minimize()
})

ipcMain.on('maximize-window', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (win?.isMaximized()) {
    win.unmaximize()
  } else {
    win?.maximize()
  }
})

ipcMain.on('close-window', () => {
  BrowserWindow.getFocusedWindow()?.close()
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
