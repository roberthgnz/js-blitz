import vm from 'vm'
import type {
  ExecuteCodeCallback,
  ExecuteResponse,
  Output,
} from '@/types/index'
import { DEFAULT_TIMEOUT } from '@/utils/constants'
import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten'

import { fetchPackageSource } from './packages'

export interface ExecuteCodeRequest {
  code: string
  packages: string[]
}

const parseConsoleArgs = (args: any[]) => {
  return args.map((arg) => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2)
      } catch (e) {
        return '[Circular]'
      }
    }
    return String(arg)
  })
}

const executeComplexCode = async (
  request: ExecuteCodeRequest,
  callback: ExecuteCodeCallback
) => {
  const { code } = request

  const module = await newQuickJSAsyncWASMModule()
  const runtime = module.newRuntime()

  try {
    callback({ status: 'code-execution-started' })

    const context = runtime.newContext()

    const output: Output[] = []

    const consoleMethods = ['log', 'info', 'warn', 'error'] as Output['type'][]

    const consoleHandle = context.newObject()

    for (const method of consoleMethods) {
      const logHandle = context.newFunction(method, (...args) => {
        const nativeArgs = args.map(context.dump)
        const value = parseConsoleArgs(nativeArgs).join(' ')
        output.push({ type: method, value })
      })

      context.setProp(consoleHandle, method, logHandle)
      logHandle.dispose()
    }

    context.setProp(context.global, 'console', consoleHandle)
    consoleHandle.dispose()

    runtime.setModuleLoader(fetchPackageSource)

    const result = await context.evalCodeAsync(code)
    context.unwrapResult(result).dispose()

    context.dispose()

    callback({ status: 'code-execution-finished' })

    return {
      output,
      success: true,
    }
  } catch (error) {
    return {
      output: [],
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  } finally {
    runtime.dispose()
  }
}

const executeSimpleCode = async (
  request: ExecuteCodeRequest,
  callback: ExecuteCodeCallback
) => {
  try {
    const { code } = request

    callback({ status: 'code-execution-started' })

    const output: Output[] = []

    const sandbox = {
      console: {
        log(...args: any[]) {
          const value = parseConsoleArgs(args).join(' ')
          output.push({ type: 'log', value })
        },
        info(...args: any[]) {
          const value = parseConsoleArgs(args).join(' ')
          output.push({ type: 'log', value })
        },
        warn(...args: any[]) {
          const value = parseConsoleArgs(args).join(' ')
          output.push({ type: 'log', value })
        },
        error(...args: any[]) {
          const value = parseConsoleArgs(args).join(' ')
          output.push({ type: 'log', value })
        },
      },
    }

    vm.createContext(sandbox)

    vm.runInContext(code, sandbox, {
      timeout: DEFAULT_TIMEOUT,
    })

    callback({ status: 'code-execution-finished' })

    return {
      output,
      success: true,
    }
  } catch (error) {
    return {
      output: [],
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}

export async function executeCode(
  request: ExecuteCodeRequest,
  callback: ExecuteCodeCallback
): Promise<ExecuteResponse> {
  if (request.packages.length === 0) {
    return executeSimpleCode(request, callback)
  }
  return executeComplexCode(request, callback)
}
