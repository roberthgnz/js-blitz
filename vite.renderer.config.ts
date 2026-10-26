import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite'

/** An opaque-origin sandbox needs a classic script, without module CORS. */
function browserExecutionFrame(): Plugin {
  const framePath = path.resolve('src/browser-frame.html')
  const scriptPath = path.resolve('src/browser-frame.ts')
  const compileFrame = async () => (await transformWithEsbuild(
    readFileSync(scriptPath, 'utf8'), scriptPath,
    { loader: 'ts', format: 'iife', target: 'es2022', sourcemap: false }
  )).code
  return {
    name: 'isolated-browser-execution-frame',
    configureServer(server) {
      // Serve before Vite's HTML transform: the sandbox must not receive the
      // HMR client or a module entry, which require a non-opaque origin.
      server.middlewares.use(async (request, response, next) => {
        const url = request.url?.split('?')[0]
        if (url !== '/browser-frame.html' && url !== '/browser-frame.js') return next()
        try {
          response.setHeader('Content-Type', url.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
          response.setHeader('Cache-Control', 'no-store')
          response.end(url.endsWith('.html') ? readFileSync(framePath, 'utf8') : await compileFrame())
        } catch (error) { next(error) }
      })
    },
    async generateBundle() {
      this.addWatchFile(framePath)
      this.addWatchFile(scriptPath)
      this.emitFile({ type: 'asset', fileName: 'browser-frame.html', source: readFileSync(framePath, 'utf8') })
      this.emitFile({ type: 'asset', fileName: 'browser-frame.js', source: await compileFrame() })
    },
  }
}

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
  plugins: [vue(), bundledNodeTypes(), browserExecutionFrame()],
  worker: { format: 'iife' },
  build: { target: 'esnext' },
})
