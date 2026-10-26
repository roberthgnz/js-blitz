import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

import type { DesktopAPI, DesktopEventMap } from '../../types'

type DesktopEvent = keyof DesktopEventMap
type Subscriber = (...args: unknown[]) => void

const events = new Set<DesktopEvent>([
  'set-theme',
  'execution-output',
  'package-installation-started',
  'package-installation-finished',
  'code-execution-started',
  'code-execution-finished',
])
const subscriptions = new Map<DesktopEvent, Set<Subscriber>>()
let initialization: Promise<void> | undefined

export const DESKTOP_UNAVAILABLE_MESSAGE =
  'Native desktop features are unavailable in this browser. Open JSBlitz in the desktop app for Node.js execution, npm installation, environment settings and AI. Use the Browser environment to run web code here.'

export function isDesktopAvailable(): boolean {
  return isTauri()
}

function requireDesktop(): void {
  if (!isDesktopAvailable()) throw new Error(DESKTOP_UNAVAILABLE_MESSAGE)
}

function dispatch(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const { event, args } = payload as { event?: unknown; args?: unknown }
  if (
    typeof event !== 'string' ||
    !events.has(event as DesktopEvent) ||
    !Array.isArray(args)
  )
    return
  const callbacks = subscriptions.get(event as DesktopEvent)
  if (!callbacks) return
  for (const callback of Array.from(callbacks)) {
    try {
      callback(...args)
    } catch (error) {
      // One component's listener must not interrupt the other subscribers.
      console.error('Desktop event listener failed:', error)
    }
  }
}

/** Register once, before mounting Vue or invoking anything that emits events. */
export function initializeDesktopBridge(): Promise<void> {
  if (!isDesktopAvailable()) return Promise.resolve()
  if (!initialization) {
    initialization = listen<unknown>('desktop-event', ({ payload }) =>
      dispatch(payload)
    ).then(
      (): void => undefined,
      (error: unknown) => {
        initialization = undefined
        throw error
      }
    )
  }
  return initialization
}

type DesktopMethod = Exclude<
  keyof DesktopAPI,
  'on' | 'minimizeWindow' | 'maximizeWindow' | 'closeWindow' | 'showContextMenu'
>

async function call<Method extends DesktopMethod>(
  method: Method,
  params: Parameters<DesktopAPI[Method]>[0] | null
): Promise<Awaited<ReturnType<DesktopAPI[Method]>>> {
  requireDesktop()
  await initializeDesktopBridge()
  return invoke<Awaited<ReturnType<DesktopAPI[Method]>>>('desktop_invoke', {
    method,
    params,
  })
}

export const desktopAPI: DesktopAPI = {
  on(event, callback) {
    if (!events.has(event)) throw new Error('Unsupported event: ' + event)
    let callbacks = subscriptions.get(event)
    if (!callbacks) subscriptions.set(event, (callbacks = new Set()))
    // Keep registrations independent when the same callback is subscribed twice.
    const subscriber: Subscriber = (...args) =>
      (callback as Subscriber)(...args)
    callbacks.add(subscriber)
    return () => {
      callbacks.delete(subscriber)
      if (!callbacks.size && subscriptions.get(event) === callbacks)
        subscriptions.delete(event)
    }
  },
  executeCode: (request) => call('executeCode', request),
  cancelExecution: (runId) => call('cancelExecution', runId),
  listPackages: () => call('listPackages', null),
  installPackage: (name) => call('installPackage', name),
  getTypeDefinitions: () => call('getTypeDefinitions', null),
  getDesktopSettings: () => call('getDesktopSettings', null),
  saveDesktopSettings: (settings) => call('saveDesktopSettings', settings),
  askAssistant: (request) => call('askAssistant', request),
  cancelAssistant: (requestId) => call('cancelAssistant', requestId),
  async minimizeWindow() {
    requireDesktop()
    await getCurrentWindow().minimize()
  },
  async maximizeWindow() {
    requireDesktop()
    await getCurrentWindow().toggleMaximize()
  },
  async closeWindow() {
    requireDesktop()
    await getCurrentWindow().close()
  },
  async showContextMenu() {
    requireDesktop()
    await initializeDesktopBridge()
    await invoke('show_context_menu')
  },
}
