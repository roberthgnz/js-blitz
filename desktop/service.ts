import { Console } from 'node:console'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'

import type { AssistantRequest, DesktopSettingsUpdate } from '../types/desktop'
import {
  askAssistant,
  cancelAllAssistantRequests,
  cancelAssistant,
} from './lib/assistant'
import {
  cancelAllExecutions,
  cancelExecution,
  configureRunner,
  executeCode,
  type ExecuteCodeRequest,
} from './lib/coderunner'
import { packageRoot } from './lib/packages'
import {
  configureSettings,
  createSecretStorage,
  getDesktopSettings,
  getExecutionEnv,
  saveDesktopSettings,
} from './lib/settings'
import { getTypeDefinitions } from './lib/type-definitions'

// stdout belongs exclusively to the native-host protocol, including dependencies.
globalThis.console = new Console({
  stdout: process.stderr,
  stderr: process.stderr,
})
syncBuiltinESMExports()

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const OWNER = 'main'
const pending = new Map<string, Promise<void>>()
let workspacePath: string | undefined
let initialization: Promise<void> | undefined
let initialized = false
let stopping = false
let closed = false

class ProtocolError extends Error {}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function invalid(message = 'Invalid request parameters.'): never {
  throw new ProtocolError(message)
}

function write(message: unknown): Promise<void> {
  if (closed) return Promise.resolve()
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(message) + '\n', () => resolve())
  })
}

function notify(event: string, ...args: unknown[]): void {
  void write({ event, args })
}

function stop(): void {
  stopping = true
  cancelAllExecutions()
  cancelAllAssistantRequests()
}

function exit(): void {
  closed = true
  stop()
  process.exit(0)
}

async function ready(): Promise<void> {
  if (initialization) await initialization
  if (!initialized) invalid('Initialize the desktop service before using it.')
}

function noParams(params: unknown): void {
  if (params !== null) invalid()
}

function identifier(params: unknown): string {
  if (typeof params !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(params))
    invalid()
  return params as string
}

function executionRequest(params: unknown): ExecuteCodeRequest {
  if (
    !object(params) ||
    typeof params.code !== 'string' ||
    params.code.length > 5 * 1024 * 1024 ||
    typeof params.runId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(params.runId) ||
    (params.language !== undefined &&
      !['javascript', 'typescript'].includes(params.language as string)) ||
    (params.timeoutMs !== undefined &&
      (typeof params.timeoutMs !== 'number' ||
        !Number.isFinite(params.timeoutMs))) ||
    (params.packages !== undefined &&
      (!Array.isArray(params.packages) ||
        params.packages.length > 200 ||
        params.packages.some(
          (name: unknown) =>
            typeof name !== 'string' || name.length > 256 || !packageRoot(name)
        )))
  )
    invalid('Invalid execution request.')
  const request = params as unknown as ExecuteCodeRequest
  // Host credentials never enter the worker; execution overrides come from the
  // saved environment settings rather than arbitrary request fields.
  return {
    code: request.code,
    runId: request.runId,
    language: request.language,
    packages: request.packages,
    timeoutMs: request.timeoutMs,
    env: getExecutionEnv(),
  }
}

async function initialize(params: unknown): Promise<null> {
  if (initialization || initialized)
    invalid('The desktop service is already initialized.')
  if (
    !object(params) ||
    typeof params.userDataPath !== 'string' ||
    !path.isAbsolute(params.userDataPath) ||
    typeof params.workspacePath !== 'string' ||
    !path.isAbsolute(params.workspacePath) ||
    (params.credentialKey !== undefined &&
      typeof params.credentialKey !== 'string')
  )
    invalid('Invalid initialization parameters.')
  const input = params as {
    userDataPath: string
    workspacePath: string
    credentialKey?: string
  }
  let storage: ReturnType<typeof createSecretStorage>
  try {
    storage = createSecretStorage(input.credentialKey)
  } catch {
    invalid('Invalid credential wrapping key.')
  }
  // Source tests may select a worker through their private process bootstrap.
  // The bundled service always uses its adjacent independently bundled worker.
  const workerPath =
    path.extname(__filename) === '.ts'
      ? path.resolve(
          process.env.JSBLITZ_WORKER_PATH ||
            path.join(__dirname, 'lib', 'execution-worker.ts')
        )
      : path.join(__dirname, 'execution-worker.cjs')
  initialization = (async () => {
    await mkdir(input.workspacePath, { recursive: true })
    await configureSettings(input.userDataPath, storage)
    configureRunner({ workspacePath: input.workspacePath, workerPath })
    workspacePath = input.workspacePath
    initialized = true
  })()
  try {
    await initialization
  } finally {
    initialization = undefined
  }
  return null
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  if (method === 'initialize') return initialize(params)
  await ready()
  // A request may already be queued behind initialize when shutdown starts.
  if (stopping) invalid('The desktop service is shutting down.')
  switch (method) {
    case 'executeCode': {
      const request = executionRequest(params)
      return executeCode(
        request,
        ({ status }) => notify(status),
        (output) => notify('execution-output', { runId: request.runId, output })
      )
    }
    case 'cancelExecution':
      cancelExecution(identifier(params))
      return null
    case 'listPackages': {
      noParams(params)
      let manifest: { dependencies?: Record<string, unknown> }
      try {
        manifest = JSON.parse(
          await readFile(path.join(workspacePath!, 'package.json'), 'utf8')
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      const packages = await Promise.all(
        Object.keys(manifest.dependencies || {}).map(async (name) => {
          if (packageRoot(name) !== name) return undefined
          try {
            const installed = JSON.parse(
              await readFile(
                path.join(workspacePath!, 'node_modules', name, 'package.json'),
                'utf8'
              )
            )
            return { name, version: String(installed.version || '') }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
              return undefined
            throw error
          }
        })
      )
      return packages.filter((entry) => entry !== undefined)
    }
    case 'installPackage': {
      if (
        typeof params !== 'string' ||
        params.length > 256 ||
        !packageRoot(params)
      )
        invalid('Enter a registry package name, optionally with a version.')
      const result = await executeCode(
        {
          code: '',
          packages: [params as string],
          runId: `install_${randomUUID()}`,
          timeoutMs: 120000,
          env: getExecutionEnv(),
        },
        ({ status }) => notify(status)
      )
      if (!result.success)
        invalid(
          'Package installation failed. Check the registry and package name, then try again.'
        )
      return null
    }
    case 'getTypeDefinitions':
      noParams(params)
      return getTypeDefinitions(workspacePath!)
    case 'getDesktopSettings':
      noParams(params)
      return getDesktopSettings()
    case 'saveDesktopSettings':
      return saveDesktopSettings(params as DesktopSettingsUpdate)
    case 'askAssistant':
      return askAssistant(params as AssistantRequest, OWNER)
    case 'cancelAssistant':
      return cancelAssistant(identifier(params), OWNER)
    default:
      invalid('Unknown desktop service method.')
  }
}

async function handle(
  id: string,
  method: string,
  params: unknown
): Promise<void> {
  try {
    if (method === 'shutdown') {
      await ready()
      noParams(params)
      if (stopping) invalid('The desktop service is shutting down.')
      stop()
      // Bound shutdown even if an outstanding filesystem/provider operation stalls.
      const timer = setTimeout(exit, 3000)
      timer.unref()
      await Promise.allSettled(
        [...pending].filter(([key]) => key !== id).map(([, task]) => task)
      )
      await write({ id, result: null })
      clearTimeout(timer)
      exit()
    } else {
      const result = await dispatch(method, params)
      await write({ id, result })
    }
  } catch (error) {
    // Raw input, parser exceptions, paths and credentials never enter errors.
    await write({
      id,
      error:
        error instanceof ProtocolError
          ? error.message
          : 'Desktop service operation failed.',
    })
  }
}

function receive(line: Buffer): void {
  let message: unknown
  try {
    message = JSON.parse(line.toString('utf8'))
  } catch {
    void write({ id: '', error: 'Invalid JSON request.' })
    return
  }
  if (
    !object(message) ||
    typeof message.id !== 'string' ||
    !message.id ||
    message.id.length > 256 ||
    typeof message.method !== 'string' ||
    !Object.hasOwn(message, 'params')
  ) {
    void write({ id: '', error: 'Invalid request envelope.' })
    return
  }
  const { id, method, params } = message
  if (stopping || pending.has(id)) {
    void write({
      id,
      error: stopping
        ? 'The desktop service is shutting down.'
        : 'This request ID is already pending.',
    })
    return
  }
  const task = handle(id, method, params).finally(() => pending.delete(id))
  pending.set(id, task)
}

// Retain bounded bytes until a complete line arrives, including split UTF-8.
let parts: Buffer[] = []
let length = 0
let discarding = false
process.stdin.on('data', (chunk: Buffer) => {
  let start = 0
  while (start < chunk.length) {
    const end = chunk.indexOf(10, start)
    const segment = chunk.subarray(start, end === -1 ? chunk.length : end)
    if (!discarding) {
      length += segment.length
      if (length > MAX_MESSAGE_BYTES) {
        parts = []
        length = 0
        discarding = true
        void write({
          id: '',
          error: 'Request exceeds the desktop service message size limit.',
        })
      } else if (segment.length) parts.push(segment)
    }
    if (end === -1) break
    if (!discarding && length) receive(Buffer.concat(parts, length))
    parts = []
    length = 0
    discarding = false
    start = end + 1
  }
})
process.stdin.once('end', exit)
process.stdin.once('close', exit)
process.stdin.once('error', exit)
process.stdout.once('error', exit)
process.once('SIGTERM', exit)
process.once('SIGINT', exit)
