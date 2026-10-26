import fs from 'fs'
import { randomUUID } from 'node:crypto'
import path from 'path'
import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron'
import started from 'electron-squirrel-startup'
import si from 'systeminformation'
import { updateElectronApp } from 'update-electron-app'

import { WindowState, type ExecuteRequest } from '../types'
import { THEMES } from '../utils/constants'
import {
  askAssistant,
  cancelAllAssistantRequests,
  cancelAssistant,
} from './lib/assistant'
import { cancelExecution, configureRunner, executeCode } from './lib/coderunner'
import { packageRoot } from './lib/packages'
import {
  getDesktopSettings,
  getExecutionEnv,
  initializeSettings,
  saveDesktopSettings,
} from './lib/settings'
import { getTypeDefinitions } from './lib/type-definitions'

if (started) {
  app.quit()
}

updateElectronApp({
  repo: 'roberthgnz/js-blitz',
  updateInterval: '1 hour',
})

const getFeedURL = () => {
  const host = 'https://update.electronjs.org'
  const feedURL = `${host}/roberthgnz/js-blitz/${process.platform}/${app.getVersion()}`
  return feedURL
}

autoUpdater.setFeedURL({
  url: getFeedURL(),
})

const userDataPath = path.resolve(app.getPath('userData'))
const stateFilePath = path.join(userDataPath, 'window-state.json')
const workspacePath = path.join(userDataPath, 'workspace')
fs.mkdirSync(userDataPath, { recursive: true })
const runsByOwner = new Map<number, Set<string>>()
const servicesReady = app.whenReady().then(async () => {
  await initializeSettings(userDataPath)
  configureRunner({
    workspacePath,
    workerPath: path.join(__dirname, 'execution-worker.js'),
  })
})

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string
declare const MAIN_WINDOW_VITE_NAME: string

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

const createContextMenu = () => {
  const template = [
    {
      label: 'Color Theme',
      submenu: THEMES.map((theme) => ({
        label: theme.label,
        click: () => {
          BrowserWindow.getFocusedWindow()?.webContents.send(
            'set-theme',
            theme.key
          )
        },
      })),
    },
    {
      label: 'GitHub',
      click: () => {
        require('electron').shell.openExternal(
          'https://github.com/roberthgnz/js-blitz'
        )
      },
    },
    {
      label: 'Check for Updates',
      click: () => {
        autoUpdater.checkForUpdates()
        autoUpdater.on('update-not-available', () => {
          require('electron').dialog.showMessageBox({
            type: 'info',
            title: 'JSBlitz',
            message: 'No updates available',
          })
        })
      },
    },
  ] as MenuItemConstructorOptions[]

  return Menu.buildFromTemplate(template)
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
  const owner = mainWindow.webContents.id
  mainWindow.webContents.once('destroyed', () => {
    for (const run of runsByOwner.get(owner) || []) cancelExecution(run)
    runsByOwner.delete(owner)
    cancelAllAssistantRequests(String(owner))
  })
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

ipcMain.handle('execute-code', async (event, request: ExecuteRequest) => {
  const webContents = event.sender
  const runId = String(webContents.id) + ':' + request?.runId
  try {
    await servicesReady
    if (
      !request ||
      typeof request.code !== 'string' ||
      typeof request.runId !== 'string' ||
      request.code.length > 5 * 1024 * 1024
    )
      throw new Error('Invalid execution request.')
    const runs = runsByOwner.get(webContents.id) || new Set<string>()
    runsByOwner.set(webContents.id, runs)
    runs.add(runId)
    return await executeCode(
      { ...request, runId, env: getExecutionEnv() },
      ({ status }) => {
        if (!webContents.isDestroyed()) webContents.send(status)
      },
      (output) => {
        if (!webContents.isDestroyed())
          webContents.send('execution-output', { runId: request.runId, output })
      }
    )
  } catch (error) {
    return {
      success: false,
      output: [],
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  } finally {
    runsByOwner.get(webContents.id)?.delete(runId)
  }
})

ipcMain.handle('cancel-execution', (event, runId: string) =>
  cancelExecution(String(event.sender.id) + ':' + runId)
)
ipcMain.handle('get-type-definitions', async () => {
  await servicesReady
  return getTypeDefinitions(workspacePath)
})
ipcMain.handle('list-packages', async () => {
  await servicesReady
  const manifestFile = path.join(workspacePath, 'package.json')
  if (!fs.existsSync(manifestFile)) return []
  const manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'))
  return Promise.all(
    Object.keys(manifest.dependencies || {}).map(async (name) => {
      const installed = JSON.parse(
        await fs.promises.readFile(
          path.join(workspacePath, 'node_modules', name, 'package.json'),
          'utf8'
        )
      )
      return { name, version: installed.version }
    })
  )
})
ipcMain.handle('install-package', async (event, name: string) => {
  await servicesReady
  if (typeof name !== 'string' || name.length > 256 || !packageRoot(name))
    throw new Error('Enter a registry package name, optionally with a version.')
  const runId = String(event.sender.id) + ':install:' + randomUUID()
  const runs = runsByOwner.get(event.sender.id) || new Set<string>()
  runsByOwner.set(event.sender.id, runs)
  runs.add(runId)
  try {
    const result = await executeCode({
      code: '',
      packages: [name],
      runId,
      timeoutMs: 120000,
      env: getExecutionEnv(),
    })
    if (!result.success)
      throw new Error(result.error || 'Package installation failed.')
  } finally {
    runs.delete(runId)
  }
})
ipcMain.handle('get-desktop-settings', async () => {
  await servicesReady
  return getDesktopSettings()
})
ipcMain.handle('save-desktop-settings', async (_event, settings) => {
  await servicesReady
  return saveDesktopSettings(settings)
})
ipcMain.handle('ask-assistant', async (event, request) => {
  await servicesReady
  return askAssistant(request, String(event.sender.id))
})
ipcMain.handle('cancel-assistant', (event, requestId: string) =>
  cancelAssistant(requestId, String(event.sender.id))
)

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

ipcMain.on('show-context-menu', (event) => {
  const menu = createContextMenu()
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) })
})

app.on('ready', async () => {
  await servicesReady
  await createWindow()
})

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
