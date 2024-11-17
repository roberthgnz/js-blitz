import { exec } from 'child_process'
import fs from 'fs/promises'
import path from 'path'
import { installPackage } from '@antfu/install-pkg'
import { app } from 'electron'

import { initPackageJson, isPackageInstalled } from './packages'

export interface ExecuteCodeRequest {
  code: string
  packages?: string[]
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

const isECMAImport = (code: string) => {
  return code.includes('import') || code.includes('export')
}

export async function executeCode(
  request: ExecuteCodeRequest,
  callback: ExecuteCodeCallback
): Promise<ExecuteResponse> {
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
    const result = await new Promise<string>((resolve, reject) => {
      exec(
        'node out.js',
        {
          cwd: projectPath,
          timeout: 10000, // 10 second timeout
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\n${stderr}`))
            return
          }
          resolve(stdout)
        }
      )
    })
    callback({ status: 'code-execution-finished' })

    return {
      success: true,
      output: result.trim(),
    }
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}
