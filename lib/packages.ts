export const initPackageJson = async (directory: string, options: any) => {
  const fs = await import('fs').then((mod) => mod.promises)
  return fs.writeFile(
    `${directory}/package.json`,
    JSON.stringify(
      { name: 'js-blitz', version: '0.0.0', private: true, ...options },
      null,
      2
    )
  )
}

export async function isPackageInstalled(
  packageName: string,
  directory: string
) {
  const path = await import('path')
  const fs = await import('fs').then((mod) => mod.promises)
  try {
    const packagePath = path.join(directory, 'node_modules', packageName)
    await fs.access(packagePath)
    return true
  } catch {
    return false
  }
}

export function getPackages(script: string): string[] {
  return getImports(script).concat(getRequires(script))
}

export const getImports = (code: string) => {
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

export const getRequires = (code: string) => {
  const REQUIRE_REGEX = /require\(["'](.+?)["']\)/g

  const modules = new Set<string>()

  let match
  while ((match = REQUIRE_REGEX.exec(code)) !== null) {
    modules.add(match[1])
  }
  return Array.from(modules)
}
