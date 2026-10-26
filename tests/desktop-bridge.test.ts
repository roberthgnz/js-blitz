import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

import type { DesktopAPI, ExecuteRequest } from '../types'
import type { AssistantRequest, DesktopSettingsUpdate } from '../types/desktop'

type BridgeModule = typeof import('../src/lib/desktop')
type NativeEventListener = (event: { payload: unknown }) => void
type Invocation = { command: string; args: Record<string, unknown> | undefined }

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Exercise the real bridge, replacing only its native Tauri imports. No browser,
// desktop process, external provider, or sidecar is needed for these contracts.
function harness(
  options: {
    native?: boolean
    register?: () => Promise<() => void>
    invoke?: (invocation: Invocation) => unknown
  } = {}
) {
  const invocations: Invocation[] = []
  const registrations: string[] = []
  const windowCalls: string[] = []
  let eventListener: NativeEventListener | undefined
  const imports: Record<string, unknown> = {
    '@tauri-apps/api/core': {
      isTauri: () => options.native !== false,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        const invocation = { command, args }
        invocations.push(invocation)
        return options.invoke?.(invocation)
      },
    },
    '@tauri-apps/api/event': {
      listen: (event: string, listener: NativeEventListener) => {
        registrations.push(event)
        eventListener = listener
        return options.register?.() ?? Promise.resolve(() => undefined)
      },
    },
    '@tauri-apps/api/window': {
      getCurrentWindow: () => ({
        minimize: async () => {
          windowCalls.push('minimize')
        },
        toggleMaximize: async () => {
          windowCalls.push('toggleMaximize')
        },
        close: async () => {
          windowCalls.push('close')
        },
      }),
    },
  }
  const source = readFileSync(
    path.join(process.cwd(), 'src/lib/desktop.ts'),
    'utf8'
  )
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    (specifier: string) => {
      assert.ok(
        Object.hasOwn(imports, specifier),
        'Unexpected import: ' + specifier
      )
      return imports[specifier]
    },
    loaded,
    loaded.exports
  )
  return {
    ...(loaded.exports as BridgeModule),
    invocations,
    registrations,
    windowCalls,
    emit(payload: unknown) {
      assert.ok(eventListener, 'The shared native listener must be registered')
      eventListener({ payload })
    },
  }
}

test('desktop RPC sends direct method params and returns backend results unchanged', async () => {
  const execution: ExecuteRequest = {
    code: 'console.log(42)',
    language: 'javascript',
    runId: 'run-1',
  }
  const settings: DesktopSettingsUpdate = {
    environment: [{ id: 'env-1', name: 'MODE', value: 'test', enabled: true }],
    assistant: {
      endpoint: 'http://localhost:11434/v1',
      model: 'local',
      timeoutMs: 1000,
    },
  }
  const assistant: AssistantRequest = {
    requestId: 'ai-1',
    prompt: 'Explain this code',
    code: execution.code,
  }
  const results: Record<string, unknown> = {
    executeCode: { success: true, output: [{ type: 'log', value: ['42'] }] },
    cancelExecution: undefined,
    listPackages: [{ name: 'nanoid', version: '5.1.0' }],
    installPackage: undefined,
    getTypeDefinitions: [
      { path: 'node_modules/nanoid/index.d.ts', content: 'export {}' },
    ],
    getDesktopSettings: { environment: [], assistant: { model: 'local' } },
    saveDesktopSettings: {
      success: false,
      error: 'Setting could not be saved',
    },
    askAssistant: {
      success: false,
      requestId: 'ai-1',
      error: 'Not configured',
      errorCode: 'not-configured',
    },
    cancelAssistant: false,
  }
  const bridge = harness({
    invoke: ({ args }) => results[args!.method as string],
  })
  const api = bridge.desktopAPI
  const requests: Array<[string, unknown, () => Promise<unknown>]> = [
    ['executeCode', execution, () => api.executeCode(execution)],
    ['cancelExecution', 'run-1', () => api.cancelExecution('run-1')],
    ['listPackages', null, () => api.listPackages()],
    ['installPackage', 'nanoid@5', () => api.installPackage('nanoid@5')],
    ['getTypeDefinitions', null, () => api.getTypeDefinitions()],
    ['getDesktopSettings', null, () => api.getDesktopSettings()],
    ['saveDesktopSettings', settings, () => api.saveDesktopSettings(settings)],
    ['askAssistant', assistant, () => api.askAssistant(assistant)],
    ['cancelAssistant', 'ai-1', () => api.cancelAssistant('ai-1')],
  ]
  for (const [method, params, request] of requests) {
    assert.strictEqual(await request(), results[method])
    assert.deepEqual(bridge.invocations.at(-1), {
      command: 'desktop_invoke',
      args: { method, params },
    })
  }
  assert.deepEqual(bridge.registrations, ['desktop-event'])
})

test('one shared event registration is ready before RPC can emit output', async () => {
  const registration = deferred<() => void>()
  const output = { runId: 'run-1', output: { type: 'log', value: ['first'] } }
  const received: unknown[] = []
  const bridge = harness({
    register: () => registration.promise,
    invoke: () => {
      bridge.emit({ event: 'execution-output', args: [output] })
      return { success: true, output: [output.output] }
    },
  })
  const unsubscribe = bridge.desktopAPI.on('execution-output', (event) =>
    received.push(event)
  )
  assert.equal(typeof unsubscribe, 'function')
  const ready = bridge.initializeDesktopBridge()
  assert.strictEqual(bridge.initializeDesktopBridge(), ready)
  const executing = bridge.desktopAPI.executeCode({
    code: '',
    language: 'javascript',
    runId: 'run-1',
  })
  await Promise.resolve()
  assert.equal(
    bridge.invocations.length,
    0,
    'RPC must wait for async listen registration'
  )
  registration.resolve(() => undefined)
  await ready
  await executing
  assert.deepEqual(received, [output])
  assert.deepEqual(bridge.registrations, ['desktop-event'])
  unsubscribe()
  bridge.emit({ event: 'execution-output', args: [output] })
  assert.equal(received.length, 1)
})

test('subscriptions whitelist events, spread arguments, and unsubscribe synchronously', async () => {
  const bridge = harness()
  await bridge.initializeDesktopBridge()
  const themes: string[] = []
  const listener = (name: string) => {
    themes.push(name)
  }
  const first = bridge.desktopAPI.on('set-theme', listener)
  const second = bridge.desktopAPI.on('set-theme', listener)
  const unsafeOn = bridge.desktopAPI.on as (
    event: string,
    callback: () => void
  ) => () => void
  assert.throws(
    () => unsafeOn('untrusted-event', () => undefined),
    /Unsupported event/
  )
  bridge.emit({ event: 'set-theme', args: ['dracula'] })
  assert.deepEqual(themes, ['dracula', 'dracula'])
  first()
  bridge.emit({ event: 'set-theme', args: ['github-dark'] })
  assert.deepEqual(themes, ['dracula', 'dracula', 'github-dark'])
  second()
  const third = bridge.desktopAPI.on('set-theme', listener)
  first() // Repeated disposal must not remove a newer subscription.
  bridge.emit({ event: 'set-theme', args: ['monokai'] })
  for (const payload of [
    null,
    {},
    { event: 'set-theme', args: 'wrong' },
    { event: 'untrusted-event', args: [] },
  ]) {
    bridge.emit(payload)
  }
  assert.deepEqual(themes, ['dracula', 'dracula', 'github-dark', 'monokai'])
  third()
  bridge.emit({ event: 'set-theme', args: ['ignored'] })
  assert.equal(themes.length, 4)

  for (const event of [
    'package-installation-started',
    'package-installation-finished',
    'code-execution-started',
    'code-execution-finished',
  ] as const) {
    let calls = 0
    const dispose = bridge.desktopAPI.on(event, () => {
      calls++
    })
    bridge.emit({ event, args: [] })
    dispose()
    bridge.emit({ event, args: [] })
    assert.equal(calls, 1)
  }
})

test('registration errors block RPC and a later initialization can retry', async () => {
  const failure = new Error('Event permission denied')
  let attempts = 0
  const bridge = harness({
    register: () =>
      ++attempts === 1
        ? Promise.reject(failure)
        : Promise.resolve(() => undefined),
  })
  await assert.rejects(
    bridge.desktopAPI.listPackages(),
    (error) => error === failure
  )
  assert.equal(bridge.invocations.length, 0)
  await bridge.initializeDesktopBridge()
  await bridge.desktopAPI.listPackages()
  assert.equal(attempts, 2)
  assert.equal(bridge.invocations.length, 1)
})

test('window controls use Tauri window methods and context menu uses its native command', async () => {
  const bridge = harness()
  await bridge.desktopAPI.minimizeWindow()
  await bridge.desktopAPI.maximizeWindow()
  await bridge.desktopAPI.closeWindow()
  assert.deepEqual(bridge.windowCalls, ['minimize', 'toggleMaximize', 'close'])
  assert.deepEqual(bridge.invocations, [])
  await bridge.desktopAPI.showContextMenu()
  assert.deepEqual(bridge.invocations, [
    { command: 'show_context_menu', args: undefined },
  ])
  assert.deepEqual(bridge.registrations, ['desktop-event'])
})

test('browser preview reports unavailable native features without calling Tauri or executing code', async () => {
  const bridge = harness({ native: false })
  assert.equal(bridge.isDesktopAvailable(), false)
  await bridge.initializeDesktopBridge()
  const api: DesktopAPI = bridge.desktopAPI
  const actions = [
    () =>
      api.executeCode({
        code: 'throw new Error("must not execute")',
        language: 'javascript',
        runId: 'browser',
      }),
    () => api.cancelExecution('browser'),
    () => api.listPackages(),
    () => api.installPackage('nanoid'),
    () => api.getTypeDefinitions(),
    () => api.getDesktopSettings(),
    () =>
      api.saveDesktopSettings({
        environment: [],
        assistant: { endpoint: '', model: '', timeoutMs: 1000 },
      }),
    () => api.askAssistant({ requestId: 'ai', prompt: '', code: '' }),
    () => api.cancelAssistant('ai'),
    () => api.minimizeWindow(),
    () => api.maximizeWindow(),
    () => api.closeWindow(),
    () => api.showContextMenu(),
  ]
  for (const action of actions) {
    await assert.rejects(action(), {
      message: bridge.DESKTOP_UNAVAILABLE_MESSAGE,
    })
  }
  const unsubscribe = api.on('set-theme', () => undefined)
  unsubscribe()
  assert.deepEqual(bridge.invocations, [])
  assert.deepEqual(bridge.registrations, [])
  assert.deepEqual(bridge.windowCalls, [])
})
