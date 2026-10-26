import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/** Dedicated utility-process build; keep compiler/npm available as runtime packages. */
export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'electron/lib/execution-worker.ts',
      formats: ['cjs'],
      fileName: () => 'execution-worker.js',
    },
    rollupOptions: {
      external: [...builtinModules, /^node:/, 'typescript', 'npm'],
    },
  },
})
