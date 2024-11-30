import {
  DYNAMIC_IMPORT_REGEX,
  ES_IMPORT_REGEX,
  REQUIRE_REGEX,
} from '@/utils/constants'

export const fetchPackageSource = async (moduleName: string) => {
  try {
    const response = await fetch(`https://esm.run/${moduleName}`)
    return response.text()
  } catch (_) {
    return null
  }
}

const getImports = (code: string) => {
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
