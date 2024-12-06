import vm from 'vm'
import type {
  ExecuteCodeCallback,
  ExecuteResponse,
  Output,
} from '@/types/index'
import { DEFAULT_TIMEOUT, RESTRICTED_MODULES } from '@/utils/constants'
import { newQuickJSAsyncWASMModule } from 'quickjs-emscripten'

import { fetchPackageSource } from './packages'

export interface ExecuteCodeRequest {
  code: string
  packages: string[]
}

const consoleMethods = ['log', 'info', 'warn', 'error'] as Output['type'][]

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

    const consoleHandle = context.newObject()

    for (const method of consoleMethods) {
      const logHandle = context.newFunction(method, (...args) => {
        const nativeArgs = args.map(context.dump)
        output.push({ type: method, value: nativeArgs })
      })

      context.setProp(consoleHandle, method, logHandle)
      logHandle.dispose()
    }

    context.setProp(context.global, 'console', consoleHandle)
    consoleHandle.dispose()

    runtime.setModuleLoader((modeuleName) => {
      if (RESTRICTED_MODULES.includes(modeuleName as any)) {
        throw new Error(`Module "${modeuleName}" is restricted`)
      }
      return fetchPackageSource(modeuleName)
    })

    const result = await context.evalCodeAsync(code)
    context.unwrapResult(result).dispose()

    context.dispose()

    callback({ status: 'code-execution-finished' })

    return {
      output,
      success: true,
    }
  } catch (error) {
    console.error('Error occurred while executing code:', error)
    return {
      output: [],
      success: false,
      error: error?.message || 'Unknown error occurred',
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
      console: consoleMethods.reduce(
        (acc, method) => {
          acc[method] = (...args: any[]) => {
            output.push({ type: method, value: args })
          }
          return acc
        },
        {} as Record<Output['type'], (...args: any[]) => void>
      ),
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
    console.error('Error occurred while executing code:', error)
    return {
      output: [],
      success: false,
      error: error?.message || 'Unknown error occurred',
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
