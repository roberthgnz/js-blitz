import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { loadConfigFromFile } from 'vite'

import type { MonacoInstance, TypeDefinition } from '../src/lib/editor'

const requireDependency = createRequire(import.meta.url)

function loadModule(
  filename: string,
  imports: Record<string, unknown>,
  self: Record<string, unknown> = {}
): any {
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  })
  const exports = {}
  runInNewContext(outputText, {
    exports,
    module: { exports },
    self,
    URL,
    console,
    require: (specifier: string) => {
      assert.ok(Object.hasOwn(imports, specifier), specifier)
      return imports[specifier]
    },
  })
  return exports
}

// Exercise Monaco's shipped compiler and lib.dom, plus our real worker subclass.
// Only the browser message transport is replaced; no browser/server is needed.
const workerModule = loadModule(
  requireDependency.resolve(
    'monaco-editor/esm/vs/language/typescript/ts.worker.js'
  ),
  { '../../editor/editor.worker.js': { initialize() {} } }
)
let createWorker: (context: unknown, data: unknown) => any
const workerSelf: Record<string, unknown> = {}
loadModule(
  'src/lib/typescript.worker.ts',
  {
    'monaco-editor/esm/vs/language/typescript/ts.worker.js': {
      ...workerModule,
      initialize(factory: typeof createWorker) {
        createWorker = factory
      },
    },
  },
  workerSelf
)
;(workerSelf.onmessage as () => void)()

async function bundledDefinitions(): Promise<TypeDefinition[]> {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'test' },
    'vite.renderer.config.ts'
  )
  const plugin = loaded?.config.plugins
    ?.flat()
    .find((plugin: any) => plugin?.name === 'bundled-editor-node-types') as any
  assert.equal(typeof plugin?.load, 'function')
  const source = await plugin.load.call(
    { addWatchFile() {} },
    '\0virtual:editor-node-types'
  )
  return JSON.parse(source.replace(/^export default /, ''))
}

const nodeDefinitions = bundledDefinitions()

async function harness(
  native = true,
  getTypeDefinitions: () => Promise<TypeDefinition[]> = async () => []
) {
  const editor = loadModule('src/lib/editor.ts', {
    'virtual:editor-node-types': {
      default: await nodeDefinitions,
      __esModule: true,
    },
    './desktop': {
      isDesktopAvailable: () => native,
      desktopAPI: { getTypeDefinitions },
    },
  }) as typeof import('../src/lib/editor')
  const providers: unknown[] = []
  const makeDefaults = () => {
    let compilerOptions = {}
    let version = 0
    const extraLibs = new Map<string, { content: string; version: number }>()
    return {
      extraLibs,
      getCompilerOptions: () => compilerOptions,
      setCompilerOptions(options: object) {
        compilerOptions = options
      },
      setDiagnosticsOptions() {},
      setEagerModelSync() {},
      setModeConfiguration() {},
      addExtraLib(content: string, path: string) {
        const library = { content, version: ++version }
        extraLibs.set(path, library)
        return {
          dispose() {
            if (extraLibs.get(path) === library) extraLibs.delete(path)
          },
        }
      },
      worker(code: string, extension = 'js') {
        const uri = `file:///workspace/scratch.${extension}`
        const model = {
          uri: { path: `/workspace/scratch.${extension}`, toString: () => uri },
          version: 1,
          getValue: () => code,
        }
        const worker = createWorker(
          { getMirrorModels: () => [model] },
          { compilerOptions, extraLibs: Object.fromEntries(extraLibs) }
        )
        return { worker, uri }
      },
    }
  }
  const javascriptDefaults = makeDefaults()
  const typescriptDefaults = makeDefaults()
  const monaco = {
    languages: {
      typescript: {
        javascriptDefaults,
        typescriptDefaults,
        ModuleKind: ts.ModuleKind,
        ScriptTarget: ts.ScriptTarget,
      },
      registerCompletionItemProvider(_language: string, provider: unknown) {
        providers.push(provider)
        return { dispose() {} }
      },
    },
  } as unknown as MonacoInstance
  editor.configureEditor(monaco)
  return { editor, monaco, javascriptDefaults, typescriptDefaults, providers }
}

test('Browser provides DOM/canvas diagnostics, completion, and hover in JS and TS', async () => {
  const h = await harness()
  h.editor.setEditorEnvironment(h.monaco, 'browser')
  for (const [defaults, extension] of [
    [h.javascriptDefaults, 'js'],
    [h.typescriptDefaults, 'ts'],
  ] as const) {
    const code = `const canvas = document.createElement('canvas')
const context = canvas.getContext('2d')
if (context) context.roundRect(0, 0, 50, 50, 8)
document.body.appendChild(canvas)
window.requestAnimationFrame(() => canvas.remove())
for (const element of document.querySelectorAll('div')) element.remove()
`
    const { worker, uri } = defaults.worker(code, extension)
    assert.equal((await worker.getSyntacticDiagnostics(uri)).length, 0)
    assert.equal((await worker.getSemanticDiagnostics(uri)).length, 0)
    const completions = await worker.getCompletionsAtPosition(
      uri,
      code.indexOf('roundRect')
    )
    assert.ok(
      completions.entries.some((entry: any) => entry.name === 'roundRect')
    )
    const hover = await worker.getQuickInfoAtPosition(
      uri,
      code.indexOf('canvas =')
    )
    assert.match(
      hover.displayParts.map((part: any) => part.text).join(''),
      /HTMLCanvasElement/
    )
    worker.getLanguageService().dispose()

    const invalid = defaults.worker(
      "document.createElement('canvas').noSuchMethod()",
      extension
    )
    assert.ok(
      (await invalid.worker.getSemanticDiagnostics(invalid.uri)).some(
        (diagnostic: any) => diagnostic.code === 2339
      ),
      'DOM names must have actual types rather than being declared as any'
    )
    invalid.worker.getLanguageService().dispose()
  }
})

test('Node and package globals cannot leak into Browser and restore on the same URI', async () => {
  const h = await harness(true, async () => [
    {
      path: 'node_modules/example/index.d.ts',
      content: 'declare const packageOnly: { answer: number };',
    },
  ])
  await h.editor.refreshPackageTypes(h.monaco)
  const code = `import { readFile } from 'node:fs/promises'
console.log(process.version, Buffer.from('hello'), readFile, packageOnly.answer)
document.createElement('canvas')
window.location.href
`
  for (const environment of ['node', 'browser', 'node', 'browser'] as const) {
    h.editor.setEditorEnvironment(h.monaco, environment)
    for (const defaults of [h.javascriptDefaults, h.typescriptDefaults]) {
      const { worker, uri } = defaults.worker(code)
      const diagnostics = await worker.getSemanticDiagnostics(uri)
      const messages = diagnostics
        .map((diagnostic: any) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        )
        .join('\n')
      if (environment === 'node') {
        assert.match(messages, /document/)
        assert.match(messages, /window/)
        assert.equal(diagnostics.length, 2, messages)
      } else {
        assert.match(messages, /node:fs\/promises/)
        assert.match(messages, /process/)
        assert.match(messages, /Buffer/)
        assert.match(messages, /packageOnly/)
        assert.equal(diagnostics.length, 4, messages)
        assert.equal(defaults.extraLibs.size, 0)
      }
      worker.getLanguageService().dispose()
    }
  }
  h.editor.configureEditor(h.monaco)
  assert.equal(
    h.providers.length,
    2,
    'Configuration must not duplicate snippets'
  )
  assert.equal(h.javascriptDefaults.extraLibs.size, 0)
})

test('a pending package refresh stays isolated after switching to Browser', async () => {
  let resolve!: (definitions: TypeDefinition[]) => void
  const pending = new Promise<TypeDefinition[]>((done) => {
    resolve = done
  })
  const h = await harness(true, () => pending)
  const refreshing = h.editor.refreshPackageTypes(h.monaco)
  h.editor.setEditorEnvironment(h.monaco, 'browser')
  resolve([
    {
      path: 'node_modules/example/index.d.ts',
      content: 'declare const packageOnly: number;',
    },
  ])
  assert.equal(await refreshing, 1)
  assert.equal(h.javascriptDefaults.extraLibs.size, 0)
  h.editor.setEditorEnvironment(h.monaco, 'node')
  const { worker, uri } = h.javascriptDefaults.worker('packageOnly.toFixed()')
  assert.equal((await worker.getSemanticDiagnostics(uri)).length, 0)
  worker.getLanguageService().dispose()
  h.editor.disposeEditorTools(h.monaco)
  assert.equal(h.javascriptDefaults.extraLibs.size, 0)
  assert.equal(h.typescriptDefaults.extraLibs.size, 0)
})

test('standalone web configuration defaults to Browser without Node globals', async () => {
  const h = await harness(false)
  assert.equal(h.javascriptDefaults.extraLibs.size, 0)
  const { worker, uri } = h.javascriptDefaults.worker(
    "document.createElement('canvas').getContext('2d')?.roundRect(0, 0, 1, 1, 0)"
  )
  assert.equal((await worker.getSemanticDiagnostics(uri)).length, 0)
  worker.getLanguageService().dispose()
})
