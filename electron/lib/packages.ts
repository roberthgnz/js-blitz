import {
  DEFAULT_CACHE_TTL,
  DYNAMIC_IMPORT_REGEX,
  ES_IMPORT_REGEX,
  REQUIRE_REGEX,
} from '@/utils/constants'
import cache from 'memory-cache'
import type { JSModuleLoadResult } from 'quickjs-emscripten'

const moduleCache = new cache.Cache()

// Add 'has' function to cache
Object.defineProperty(moduleCache, 'has', {
  value: function (key: string) {
    return this.keys().includes(key)
  },
  writable: true,
  configurable: true,
})

export const fetchPackageSource = async (moduleName: string) => {
  const origin = 'https://esm.sh/'
  const u = new URL(moduleName, origin)

  if (!origin.includes(u.origin)) {
    throw new Error(`Invalid import "${moduleName}"`)
  }

  const url = u.toString()

  // @ts-ignore
  if (!moduleCache.has(url)) {
    const bundled = await fetch(url).then(
      (response) => response.text() as Promise<JSModuleLoadResult>
    )
    moduleCache.put(url, bundled, DEFAULT_CACHE_TTL)
  }

  return Promise.resolve(moduleCache.get(url) as JSModuleLoadResult)
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
