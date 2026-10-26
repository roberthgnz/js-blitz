import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ExecuteCodeCallback } from '../../types/index'

export interface ExecuteCodeRequest {
  code: string
  packages?: string[]
  runId?: string
  language?: 'javascript' | 'typescript'
  env?: Record<string, string>
  timeoutMs?: number
}

export interface RunnerOutput {
  type: 'log' | 'info' | 'warn' | 'error' | 'result'
  value: string[]
  line?: number
}

export interface ExecuteResponse {
  success: boolean
  output: RunnerOutput[]
  error?: string
}

export interface RunnerConfiguration {
  workspacePath: string
  workerPath: string
}

let configuration: RunnerConfiguration = {
  workspacePath: path.join(tmpdir(), 'js-blitz-workspace'),
  workerPath: path.join(__dirname, 'execution-worker.js'),
}

/** Configure a writable workspace and the built worker after Electron app.ready. */
export function configureRunner(options: RunnerConfiguration): void {
  configuration = {
    workspacePath: path.resolve(options.workspacePath),
    workerPath: path.resolve(options.workerPath),
  }
}

interface WorkerHandle {
  send: (message: unknown) => void
  kill: () => void
  on: (event: string, listener: (...args: any[]) => void) => unknown
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
}

const activeRuns = new Map<string, { cancel: () => void }>()
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUTS = 10_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Out-of-process termination also stops loops, timers, and package installation. */
export function cancelExecution(runId: string): void {
  activeRuns.get(runId)?.cancel()
}

async function startWorker(
  config: RunnerConfiguration,
  env?: Record<string, string>
): Promise<WorkerHandle> {
  const workerEnv = { ...process.env }
  for (const [key, value] of Object.entries(env || {})) {
    if (process.platform === 'win32') {
      const inherited = Object.keys(workerEnv).find(name => name.toLowerCase() === key.toLowerCase())
      if (inherited) delete workerEnv[inherited]
    }
    workerEnv[key] = value
  }
  delete workerEnv.NODE_OPTIONS
  delete workerEnv.ELECTRON_RUN_AS_NODE
  if (process.versions.electron) {
    const { utilityProcess } = await import('electron')
    const child = utilityProcess.fork(config.workerPath, [], {
      cwd: config.workspacePath,
      env: workerEnv,
      stdio: 'pipe',
      execArgv: ['--max-old-space-size=256'],
      serviceName: 'JSBlitz code runner',
    })
    return {
      send: (message) => child.postMessage(message),
      kill: () => {
        const pid = child.pid
        child.kill()
        if (pid && process.platform !== 'win32') {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already exited */
          }
        }
      },
      on: (event, listener) => child.on(event as any, listener),
      stdout: child.stdout,
      stderr: child.stderr,
    }
  }
  // Node-only regression-suite fallback; packaged Electron always uses utilityProcess.
  const child = fork(config.workerPath, [], {
    cwd: config.workspacePath,
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: config.workerPath.endsWith('.ts')
      ? [
          '--import',
          pathToFileURL(createRequire(__filename).resolve('tsx')).href,
        ]
      : [],
    serialization: 'advanced',
    windowsHide: true,
  })
  return {
    send: (message) => child.send(message as any),
    kill: () => {
      child.kill('SIGKILL')
    },
    on: (event, listener) => child.on(event, listener),
    stdout: child.stdout,
    stderr: child.stderr,
  }
}

function notify(
  callback: ExecuteCodeCallback | undefined,
  status: Parameters<ExecuteCodeCallback>[0]['status']
): void {
  try {
    callback?.({ status })
  } catch {
    /* a closed renderer must not strand the worker */
  }
}

export async function executeCode(
  request: ExecuteCodeRequest,
  callback?: ExecuteCodeCallback,
  onOutput?: (output: RunnerOutput) => void
): Promise<ExecuteResponse> {
  const runId = request.runId || randomUUID()
  if (activeRuns.has(runId)) {
    return {
      success: false,
      output: [],
      error: `Execution "${runId}" is already running`,
    }
  }
  const config = { ...configuration }
  const filePath = path.join(
    config.workspacePath,
    `.jsblitz-run-${randomUUID()}.mjs`
  )
  const output: RunnerOutput[] = []
  const timeoutMs = Number.isFinite(request.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1, request.timeoutMs!))
    : DEFAULT_TIMEOUT_MS

  return new Promise<ExecuteResponse>((resolve) => {
    let child: WorkerHandle | undefined
    let settled = false
    let outputBytes = 0
    let truncated = false
    let installationStarted = false
    const append = (entry: RunnerOutput) => {
      if (settled || truncated) return
      const bytes = entry.value.reduce(
        (total, value) => total + Buffer.byteLength(value),
        0
      )
      if (
        output.length >= MAX_OUTPUTS ||
        outputBytes + bytes > MAX_OUTPUT_BYTES
      ) {
        truncated = true
        const warning: RunnerOutput = {
          type: 'warn',
          value: ['Output truncated: execution output limit reached.'],
        }
        output.push(warning)
        try {
          onOutput?.(warning)
        } catch {
          /* observer error */
        }
        return
      }
      outputBytes += bytes
      output.push(entry)
      try {
        onOutput?.(entry)
      } catch {
        /* observer error */
      }
    }
    const finish = (success: boolean, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child?.kill()
      activeRuns.delete(runId)
      if (installationStarted) notify(callback, 'package-installation-finished')
      notify(callback, 'code-execution-finished')
      void rm(filePath, { force: true }).catch((): void => {})
      resolve({ success, output, ...(error ? { error } : {}) })
    }
    const timer = setTimeout(
      () => finish(false, `Execution timed out after ${timeoutMs} ms`),
      timeoutMs
    )
    activeRuns.set(runId, {
      cancel: () => finish(false, 'Execution cancelled'),
    })
    notify(callback, 'code-execution-started')

    void (async () => {
      try {
        if (typeof request.code !== 'string')
          throw new TypeError('Code must be a string')
        await mkdir(config.workspacePath, { recursive: true })
        if (settled) return
        child = await startWorker(config, request.env)
        if (settled) {
          child.kill()
          return
        }
        child.on('error', (error: unknown) =>
          finish(false, error instanceof Error ? error.message : String(error))
        )
        child.on('exit', (code: number) => {
          if (!settled)
            finish(
              false,
              `Execution worker exited before completion (code ${code})`
            )
        })
        child.on('message', (message: any) => {
          if (settled || !message || typeof message !== 'object') return
          if (
            message.kind === 'output' &&
            message.output &&
            Array.isArray(message.output.value)
          ) {
            append(message.output)
          } else if (message.kind === 'status') {
            if (message.status === 'package-installation-started')
              installationStarted = true
            if (message.status === 'package-installation-finished')
              installationStarted = false
            if (
              message.status === 'package-installation-started' ||
              message.status === 'package-installation-finished'
            ) {
              notify(callback, message.status)
            }
          } else if (message.kind === 'complete') {
            finish(message.success === true, message.error)
          }
        })
        child.stdout?.on('data', (chunk: Buffer) =>
          append({ type: 'log', value: [chunk.toString().trimEnd()] })
        )
        child.stderr?.on('data', (chunk: Buffer) =>
          append({ type: 'error', value: [chunk.toString().trimEnd()] })
        )
        child.send({
          kind: 'execute',
          request,
          workspacePath: config.workspacePath,
          filePath,
        })
      } catch (error) {
        finish(false, error instanceof Error ? error.message : String(error))
      }
    })()
  })
}
