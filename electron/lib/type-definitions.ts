import type { Dirent } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import type { TypeDefinition } from '../../types'

/** Only expose declaration files and package metadata from the package workspace. */
export async function getTypeDefinitions(
  workspacePath: string
): Promise<TypeDefinition[]> {
  const root = path.join(workspacePath, 'node_modules')
  const definitions: TypeDefinition[] = []
  const visited = new Set<string>()
  let totalBytes = 0
  async function walk(directory: string): Promise<void> {
    if (definitions.length >= 4000 || totalBytes > 24 * 1024 * 1024) return
    const resolved = await realpath(directory).catch(() => '')
    if (!resolved || visited.has(resolved)) return
    visited.add(resolved)
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (): Dirent[] => []
    )
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'npm') continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory() || entry.isSymbolicLink()) await walk(file)
      else if (
        entry.name.endsWith('.d.ts') ||
        entry.name.endsWith('.d.mts') ||
        entry.name.endsWith('.d.cts') ||
        entry.name === 'package.json'
      ) {
        if (definitions.length >= 4000 || totalBytes > 24 * 1024 * 1024) return
        const content = await readFile(file, 'utf8')
        totalBytes += Buffer.byteLength(content)
        definitions.push({
          path:
            'file:///workspace/' +
            path.relative(workspacePath, file).split(path.sep).join('/'),
          content,
        })
      }
    }
  }
  await walk(root)
  return definitions
}
