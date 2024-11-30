import { exec } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import util from 'util'
import { installPackage } from '@antfu/install-pkg'
import { app } from 'electron'
import { DEFAULT_TIMEOUT } from 'utils/constants'

import { initPackageJson, isPackageInstalled } from './packages'

export interface ExecuteCodeRequest {
  code: string
  packages: string[]
}

export interface ExecuteResponse {
  success: boolean
  output: string
  error?: string
}

type ExecuteCodeStatus =
  | 'package-installation-started'
  | 'package-installation-finished'
  | 'code-execution-started'
  | 'code-execution-finished'

type ExecuteCodeCallback = (status: { status: ExecuteCodeStatus }) => void

const execPromise = util.promisify(exec)

const isECMAImport = (code: string) => {
  return code.includes('import') || code.includes('export')
}

const executeComplexCode = async (
  request: ExecuteCodeRequest,
  callback: ExecuteCodeCallback
) => {
  const { code, packages = [] } = request

  const userDataPath = app.isPackaged
    ? path.resolve(app.getPath('userData'))
    : path.resolve(__dirname, '..', '..', 'temp')

  const projectPath = path.join(userDataPath, 'project')

  try {
    const exists = await fs
      .access(projectPath)
      .then(() => true)
      .catch(() => false)
    if (!exists) {
      await fs.mkdir(projectPath)
    }

    const isECMA = isECMAImport(code)

    await initPackageJson(projectPath, {
      type: isECMA ? 'module' : 'commonjs',
    })

    if (packages.length > 0) {
      callback({ status: 'package-installation-started' })
      for await (const packageName of packages) {
        const isInstalled = await isPackageInstalled(packageName, projectPath)
        if (!isInstalled) {
          await installPackage(packageName, { cwd: projectPath })
        }
      }
      callback({ status: 'package-installation-finished' })
    }

    const filename = 'out.js'
    const filepath = path.join(projectPath, filename)
    await fs.writeFile(filepath, code, 'utf8')

    callback({ status: 'code-execution-started' })
    const { stdout, stderr } = await execPromise('node out.js', {
      cwd: projectPath,
      timeout: DEFAULT_TIMEOUT,
    })
    if (stderr) {
      throw new Error(stderr)
    }
    callback({ status: 'code-execution-finished' })

    return {
      success: true,
      output: stdout.trim(),
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}

const executeSimpleCode = async (
  request: ExecuteCodeRequest,
  callback: ExecuteCodeCallback
) => {
  try {
    const { code } = request

    callback({ status: 'code-execution-started' })
    const { stdout, stderr } = await execPromise(code, {
      timeout: DEFAULT_TIMEOUT,
    })
    if (stderr) {
      throw new Error(stderr)
    }
    callback({ status: 'code-execution-finished' })

    return {
      success: true,
      output: stdout.trim(),
    }
  } catch (error) {
    return {
      success: false,
      output: '',
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
