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

const getImports = (code: string) => {
  const ES_IMPORT_REGEX = /import\s+(?:[\w*{}\s,]*\s+from\s+)?["'](.+?)["'];?/g
  const DYNAMIC_IMPORT_REGEX = /import\(["'](.+?)["']\)/g

  const modules = new Set<string>()

  let match
  while ((match = ES_IMPORT_REGEX.exec(code)) !== null) {
    modules.add(match[1])
  }

  while ((match = DYNAMIC_IMPORT_REGEX.exec(code)) !== null) {
    modules.add(match[1])
  }
  return Array.from(modules)
}

const getRequires = (code: string) => {
  const REQUIRE_REGEX = /require\(["'](.+?)["']\)/g

  const modules = new Set<string>()

  let match
  while ((match = REQUIRE_REGEX.exec(code)) !== null) {
    modules.add(match[1])
  }
  return Array.from(modules)
}

export function getPackages(script: string): string[] {
  return getImports(script).concat(getRequires(script))
}
