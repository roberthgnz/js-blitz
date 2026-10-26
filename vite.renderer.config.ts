import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/** Ship the installed Node declarations, including pnpm's transitive undici types. */
function bundledNodeTypes(): Plugin {
  const moduleId = 'virtual:editor-node-types'
  const resolvedId = `\0${moduleId}`

  return {
    name: 'bundled-editor-node-types',
    resolveId(id) {
      return id === moduleId ? resolvedId : undefined
    },
    load(id) {
      if (id !== resolvedId) return

      const require = createRequire(import.meta.url)
      const nodeManifest = require.resolve('@types/node/package.json')
      const nodeRequire = createRequire(nodeManifest)
      const packages = [
        ['@types/node', nodeManifest],
        ['undici-types', nodeRequire.resolve('undici-types/package.json')],
      ]
      const definitions: { path: string; content: string }[] = []

      for (const [name, manifestPath] of packages) {
        const root = path.dirname(manifestPath)
        // Monaco 0.52 embeds TS 5.4. Node 22's ts5.6 declarations support TS 4.9–5.6.
        const compatibilityFiles =
          name === '@types/node'
            ? new Set(
                readdirSync(root, { withFileTypes: true }).some(
                  (entry) => entry.name === 'ts5.6' && entry.isDirectory()
                )
                  ? readdirSync(path.join(root, 'ts5.6'))
                  : []
              )
            : new Set<string>()

        const visit = (directory: string, relative = '') => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const filePath = path.join(directory, entry.name)
            const fileName = `${relative}${entry.name}`
            if (entry.isDirectory()) {
              if (/^ts\d/.test(entry.name) && entry.name !== 'ts5.6') continue
              visit(filePath, `${fileName}/`)
            } else if (
              /\.d\.(?:ts|mts|cts)$/.test(entry.name) &&
              !(relative === '' && compatibilityFiles.has(entry.name))
            ) {
              this.addWatchFile(filePath)
              definitions.push({
                path: `file:///workspace/node_modules/${name}/${fileName}`,
                content: readFileSync(filePath, 'utf8'),
              })
            }
          }
        }

        visit(root)
        this.addWatchFile(manifestPath)
        definitions.push({
          path: `file:///workspace/node_modules/${name}/package.json`,
          content: readFileSync(manifestPath, 'utf8'),
        })
      }

      return `export default ${JSON.stringify(definitions)}`
    },
  }
}

export default defineConfig({
  base: './',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  plugins: [vue(), bundledNodeTypes()],
  worker: { format: 'iife' },
  build: { target: 'esnext' },
})
