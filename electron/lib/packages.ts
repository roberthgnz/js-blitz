import fs from 'fs/promises'
import path from 'path'

export const initPackageJson = (directory: string, options: any) => {
  return fs.writeFile(
    `${directory}/package.json`,
    JSON.stringify(
      { name: 'js-blitz', version: '0.0.0', private: true, ...options },
      null,
      2
    )
  )
}

export const isPackageInstalled = async (
  packageName: string,
  directory: string
) => {
  try {
    const packagePath = path.join(directory, 'node_modules', packageName)
    await fs.access(packagePath)
    return true
  } catch {
    return false
  }
}
