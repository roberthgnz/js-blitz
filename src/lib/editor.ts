import type * as Monaco from 'monaco-editor'
import nodeDefinitions from 'virtual:editor-node-types'

import { desktopAPI, isDesktopAvailable } from './desktop'

export type MonacoInstance = typeof Monaco

export interface TypeDefinition {
  path: string
  content: string
}

interface RegisteredLibrary {
  content: string
  disposables: Monaco.IDisposable[]
}

interface EditorTools {
  environment: 'node' | 'browser'
  providers: Monaco.IDisposable[]
  bundledLibraries: Map<string, RegisteredLibrary>
  packageLibraries: Map<string, RegisteredLibrary>
  refreshVersion: number
}

const configuredEditors = new WeakMap<MonacoInstance, EditorTools>()

const snippets = [
  {
    label: 'log',
    detail: 'Log a value',
    insertText: 'console.log(${1:value})$0',
  },
  {
    label: 'table',
    detail: 'Display rows as a table',
    insertText: 'console.table(${1:rows})$0',
  },
  {
    label: 'time',
    detail: 'Measure an operation',
    insertText:
      "console.time('${1:operation}')\n${2:// operation}\nconsole.timeEnd('${1:operation}')$0",
  },
  {
    label: 'afn',
    detail: 'Async function',
    insertText:
      'async function ${1:run}(${2:args}) {\n\t${3:// implementation}\n}$0',
  },
  {
    label: 'fetchjson',
    detail: 'Fetch JSON and check the HTTP status',
    insertText:
      "const response = await fetch('${1:https://example.com/api}')\nif (!response.ok) throw new Error('HTTP ' + response.status)\nconst ${2:data} = await response.json()\nconsole.log(${2:data})$0",
  },
  {
    label: 'tryawait',
    detail: 'Handle an asynchronous operation',
    insertText:
      'try {\n\tconst ${1:result} = await ${2:operation()}\n\tconsole.log(${1:result})\n} catch (error) {\n\tconsole.error(error)\n}$0',
  },
  {
    label: 'parallel',
    detail: 'Run asynchronous operations in parallel',
    insertText:
      'const [${1:first}, ${2:second}] = await Promise.all([\n\t${3:firstOperation()},\n\t${4:secondOperation()},\n])$0',
  },
  {
    label: 'sleep',
    detail: 'Pause using Node timers/promises',
    insertText:
      "const { setTimeout: sleep } = await import('node:timers/promises')\nawait sleep(${1:1000})$0",
  },
  {
    label: 'readjson',
    detail: 'Read a local JSON file',
    insertText:
      "const { readFile } = await import('node:fs/promises')\nconst ${1:data} = JSON.parse(await readFile('${2:./data.json}', 'utf8'))\nconsole.log(${1:data})$0",
  },
  {
    label: 'writejson',
    detail: 'Write a local JSON file',
    insertText:
      "const { writeFile } = await import('node:fs/promises')\nawait writeFile('${1:./data.json}', JSON.stringify(${2:data}, null, 2))$0",
  },
  {
    label: 'map',
    detail: 'Transform every item in an array',
    insertText:
      'const ${1:result} = ${2:items}.map((${3:item}) => ${4:item})$0',
  },
  {
    label: 'reduce',
    detail: 'Accumulate an array into a value',
    insertText:
      'const ${1:result} = ${2:items}.reduce((${3:total}, ${4:item}) => {\n\treturn ${5:total + item}\n}, ${6:0})$0',
  },
]

function languageDefaults(monaco: MonacoInstance) {
  return [
    monaco.languages.typescript.javascriptDefaults,
    monaco.languages.typescript.typescriptDefaults,
  ]
}

function registerLibrary(
  monaco: MonacoInstance,
  definition: TypeDefinition,
  active: boolean
): RegisteredLibrary {
  return {
    content: definition.content,
    disposables: active
      ? languageDefaults(monaco).map((defaults) =>
          defaults.addExtraLib(definition.content, definition.path)
        )
      : [],
  }
}

function disposeLibrary(library: RegisteredLibrary) {
  library.disposables.forEach((disposable) => disposable.dispose())
  library.disposables = []
}

function environmentCompilerOptions(
  environment: 'node' | 'browser'
): Monaco.languages.typescript.CompilerOptions {
  return environment === 'browser'
    ? {
        customConditions: ['browser'],
        lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        typeRoots: [],
        types: [],
      }
    : {
        customConditions: ['node'],
        lib: ['lib.esnext.d.ts'],
        typeRoots: ['file:///workspace/node_modules/@types'],
        types: ['node'],
      }
}

/** Configure once per Monaco instance; safe to call from every editor mount. */
export function configureEditor(monaco: MonacoInstance): void {
  if (configuredEditors.has(monaco)) return

  const environment = isDesktopAvailable() ? 'node' : 'browser'
  const typescript = monaco.languages.typescript
  const compilerOptions: Monaco.languages.typescript.CompilerOptions = {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    allowUmdGlobalAccess: true,
    baseUrl: 'file:///workspace',
    checkJs: true,
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
    module: typescript.ModuleKind.ESNext,
    // The embedded TS 5.4 supports Bundler; Monaco's public enum is older.
    moduleResolution: 100 as Monaco.languages.typescript.ModuleResolutionKind,
    // Treat each scratchpad as a module: independent tabs and top-level await.
    moduleDetection: 3,
    noEmit: true,
    noImplicitAny: false,
    noLib: false,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: true,
    target: typescript.ScriptTarget.ESNext,
    ...environmentCompilerOptions(environment),
  }

  for (const defaults of languageDefaults(monaco)) {
    defaults.setCompilerOptions(compilerOptions)
    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: false,
      diagnosticCodesToIgnore: [],
    })
    defaults.setEagerModelSync(true)
    defaults.setModeConfiguration({
      completionItems: true,
      definitions: true,
      diagnostics: true,
      documentHighlights: true,
      documentRangeFormattingEdits: true,
      documentSymbols: true,
      hovers: true,
      inlayHints: true,
      onTypeFormattingEdits: true,
      references: true,
      rename: true,
      signatureHelp: true,
    })
  }

  const tools: EditorTools = {
    environment,
    providers: [],
    bundledLibraries: new Map(),
    packageLibraries: new Map(),
    refreshVersion: 0,
  }
  configuredEditors.set(monaco, tools)

  for (const definition of nodeDefinitions) {
    tools.bundledLibraries.set(
      definition.path,
      registerLibrary(monaco, definition, environment === 'node')
    )
  }

  for (const language of ['javascript', 'typescript']) {
    tools.providers.push(
      monaco.languages.registerCompletionItemProvider(language, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position)
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn
          )
          return {
            suggestions: snippets.map((snippet) => ({
              ...snippet,
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
            })),
          }
        },
      })
    )
  }
}

/** Monaco shares JS/TS defaults, so apply the active tab's execution environment. */
export function setEditorEnvironment(
  monaco: MonacoInstance,
  environment: 'node' | 'browser'
): void {
  configureEditor(monaco)
  const tools = configuredEditors.get(monaco)!
  if (tools.environment === environment) return
  tools.environment = environment

  // Extra libs are root files: types: [] alone cannot hide their Node globals.
  // Retain the declarations in memory so switching back needs no bridge request.
  for (const libraries of [tools.bundledLibraries, tools.packageLibraries]) {
    for (const [path, library] of libraries) {
      if (environment === 'browser') {
        disposeLibrary(library)
      } else {
        library.disposables = languageDefaults(monaco).map((defaults) =>
          defaults.addExtraLib(library.content, path)
        )
      }
    }
  }
  for (const defaults of languageDefaults(monaco)) {
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      ...environmentCompilerOptions(environment),
    })
  }
}

/** Convert bridge paths into the same virtual filesystem used by tab models. */
export function normalizeTypeDefinitionPath(filePath: string): string | null {
  let path = filePath.replace(/\\/g, '/')
  if (path.startsWith('file:')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return null
    }
  }
  let index = path.indexOf('/node_modules/')
  if (index >= 0) path = path.slice(index + 1)
  if (!path.startsWith('node_modules/')) return null

  // A backend may resolve a pnpm symlink before returning its absolute path.
  if (path.startsWith('node_modules/.pnpm/')) {
    index = path.indexOf('/node_modules/', 'node_modules/.pnpm/'.length)
    if (index < 0) return null
    path = path.slice(index + 1)
  }
  if (path.split('/').some((part) => part === '..' || part === '.')) return null
  if (!/\.d\.(?:ts|mts|cts)$/.test(path) && !path.endsWith('/package.json')) {
    return null
  }
  const encodedPath = encodeURI(`/workspace/${path}`)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
  return new URL(encodedPath, 'file:///').href
}

/** Reload Node package declarations/manifests; keep them inactive in Browser. */
export async function refreshPackageTypes(
  monaco: MonacoInstance
): Promise<number> {
  configureEditor(monaco)
  const tools = configuredEditors.get(monaco)!
  const version = ++tools.refreshVersion
  if (!isDesktopAvailable()) return 0

  const definitions = await desktopAPI.getTypeDefinitions()
  if (
    configuredEditors.get(monaco) !== tools ||
    tools.refreshVersion !== version
  ) {
    return tools.packageLibraries.size
  }
  const incoming = new Map<string, string>()
  for (const definition of definitions) {
    const path = normalizeTypeDefinitionPath(definition.path)
    // Keep one Node compatibility variant, even if an npm dependency ships another.
    const isBundledPackage =
      path && /\/node_modules\/(?:@types\/node|undici-types)\//.test(path)
    if (path && !isBundledPackage && !tools.bundledLibraries.has(path)) {
      incoming.set(path, definition.content)
    }
  }

  for (const [path, library] of tools.packageLibraries) {
    if (incoming.get(path) !== library.content) {
      disposeLibrary(library)
      tools.packageLibraries.delete(path)
    }
  }
  for (const [path, content] of incoming) {
    if (!tools.packageLibraries.has(path)) {
      tools.packageLibraries.set(
        path,
        registerLibrary(monaco, { path, content }, tools.environment === 'node')
      )
    }
  }
  return tools.packageLibraries.size
}

/** Dispose at application teardown, rather than when changing tabs. */
export function disposeEditorTools(monaco: MonacoInstance): void {
  const tools = configuredEditors.get(monaco)
  if (!tools) return
  tools.refreshVersion++
  tools.providers.forEach((provider) => provider.dispose())
  tools.bundledLibraries.forEach(disposeLibrary)
  tools.packageLibraries.forEach(disposeLibrary)
  configuredEditors.delete(monaco)
}
