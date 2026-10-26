import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspect } from 'node:util'
import ts from 'typescript'

import type { ExecuteCodeRequest, RunnerOutput } from './coderunner'
import { ensurePackages, getPackages } from './packages'

interface ExecutionMessage {
  kind: 'execute'
  request: ExecuteCodeRequest
  workspacePath: string
  filePath: string
}
const send = (message: unknown) => {
  if (process.connected) process.send?.(message as any)
}

let completed = false
let moduleFinished = false
let executing = false
let outputCount = 0
let outputBytes = 0

function serialize(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return inspect(value, {
      depth: 8,
      colors: false,
      customInspect: false,
      getters: false,
      maxArrayLength: 100,
      maxStringLength: 20_000,
      breakLength: Infinity,
    })
  } catch (error) {
    return `[Unserializable value: ${error instanceof Error ? error.message : String(error)}]`
  }
}

function emit(
  type: RunnerOutput['type'],
  values: unknown[],
  line?: number
): void {
  if (completed) return
  if (outputCount >= 10_000 || outputBytes >= 4 * 1024 * 1024) {
    if (outputCount === 10_000) {
      send({
        kind: 'output',
        output: {
          type: 'warn',
          value: ['Output truncated: execution output limit reached.'],
        },
      })
      outputCount++
    }
    return
  }
  const value = values.map(serialize)
  outputCount++
  outputBytes += value.reduce(
    (total, part) => total + Buffer.byteLength(part),
    0
  )
  send({ kind: 'output', output: { type, value, ...(line ? { line } : {}) } })
}

function complete(success: boolean, error?: string): void {
  if (completed) return
  completed = true
  send({ kind: 'complete', success, ...(error ? { error } : {}) })
}

function fail(error: unknown): void {
  const text =
    error instanceof Error ? error.stack || error.message : serialize(error)
  emit('error', [text])
  complete(false, error instanceof Error ? error.message : serialize(error))
}

process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)
process.on('beforeExit', () => {
  if (!executing || completed) return
  if (moduleFinished) complete(true)
  else complete(false, 'Execution contains an unresolved top-level await')
})

function compile(
  code: string,
  language: ExecuteCodeRequest['language'],
  helperName: string,
  filePath: string
): string {
  const result = ts.transpileModule(code, {
    fileName: language === 'javascript' ? 'snippet.js' : 'snippet.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      isolatedModules: true,
      esModuleInterop: true,
      inlineSourceMap: true,
      inlineSources: true,
    },
    reportDiagnostics: true,
    transformers: {
      before: [
        (context) => (sourceFile) => {
          const statements = sourceFile.statements.map((statement) => {
            if (!ts.isExpressionStatement(statement)) return statement
            if (
              ts.isStringLiteral(statement.expression) &&
              ['use strict', 'use asm'].includes(statement.expression.text)
            )
              return statement
            const line =
              sourceFile.getLineAndCharacterOfPosition(
                statement.getStart(sourceFile)
              ).line + 1
            const call = context.factory.createCallExpression(
              context.factory.createPropertyAccessExpression(
                context.factory.createIdentifier('globalThis'),
                helperName
              ),
              undefined,
              [statement.expression, context.factory.createNumericLiteral(line)]
            )
            ts.setTextRange(call, statement.expression)
            return context.factory.updateExpressionStatement(statement, call)
          })
          return context.factory.updateSourceFile(sourceFile, statements)
        },
      ],
    },
  })
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  if (errors?.length) {
    throw new SyntaxError(
      errors
        .map((error) => {
          const line =
            error.file && error.start !== undefined
              ? ` (line ${error.file.getLineAndCharacterOfPosition(error.start).line + 1})`
              : ''
          return ts.flattenDiagnosticMessageText(error.messageText, '\n') + line
        })
        .join('\n')
    )
  }
  // Source maps refer to a stable virtual source beside the generated module.
  return result.outputText + `\n//# sourceURL=${pathToFileURL(filePath).href}\n`
}

async function execute(message: ExecutionMessage): Promise<void> {
  executing = true
  const { request, workspacePath, filePath } = message
  await ensurePackages(
    workspacePath,
    [...(request.packages || []), ...getPackages(request.code)],
    {
      onStatus: ({ status }) => send({ kind: 'status', status }),
    }
  )

  for (const type of [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'dir',
    'table',
    'trace',
  ] as const) {
    const outputType =
      type === 'debug' || type === 'dir' || type === 'table' || type === 'trace'
        ? 'log'
        : type
    ;(console as any)[type] = (...values: unknown[]) => emit(outputType, values)
  }
  console.assert = (condition: unknown, ...values: unknown[]) => {
    if (!condition) emit('error', ['Assertion failed:', ...values])
  }
  // Keep `import {log} from 'node:console'` consistent with the global console.
  syncBuiltinESMExports()

  const globals = globalThis as unknown as Record<string, any>
  const requireFromWorkspace = createRequire(filePath)
  globals.require = requireFromWorkspace
  globals.__filename = filePath
  globals.__dirname = workspacePath
  globals.module = { exports: {} }
  globals.exports = globals.module.exports
  const helperName = `__jsblitz_result_${randomUUID().replace(/-/g, '')}`
  globals[helperName] = (value: unknown, line: number) => {
    // Console calls, assignments to undefined, and void statements are silent.
    if (value !== undefined) emit('result', [value], line)
    return value
  }
  ;(
    process as NodeJS.Process & {
      setSourceMapsEnabled?: (enabled: boolean) => void
    }
  ).setSourceMapsEnabled?.(true)
  writeFileSync(
    filePath,
    compile(request.code, request.language, helperName, filePath)
  )
  // Native import preserves npm export maps, CJS interop, ESM-only packages and TLA.
  // Using Function prevents the CommonJS bundler from rewriting this into require().
  const nativeImport = new Function(
    'specifier',
    'return import(specifier)'
  ) as (specifier: string) => Promise<unknown>
  await nativeImport(pathToFileURL(filePath).href)
  moduleFinished = true
  // Let Node drain timers, I/O and microtasks naturally before beforeExit reports success.
}

function receive(message: ExecutionMessage): void {
  if (!message || message.kind !== 'execute' || executing) return
  // A referenced Node IPC listener would otherwise prevent beforeExit forever.
  process.channel?.unref()
  void execute(message).catch(fail)
}

process.once('message', (message) => receive(message as ExecutionMessage))
// IPC loss is a second guard against a terminated service leaving work running.
process.once('disconnect', () => process.exit(0))
