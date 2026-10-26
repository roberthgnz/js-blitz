import ts from 'typescript'

export interface BrowserCompileRequest {
  code: string
  language: 'javascript' | 'typescript'
  resultName: string
  guardName: string
}

const nodeModules = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'sqlite', 'stream', 'string_decoder', 'sys',
  'test', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8',
  'vm', 'wasi', 'worker_threads', 'zlib',
])

function browserSpecifier(specifier: string): string {
  if (specifier.startsWith('node:') || nodeModules.has(specifier.split('/')[0]))
    throw new Error(
      `The Node module "${specifier}" is unavailable in Browser mode. Switch to Node mode or use a browser API.`
    )
  if (/^(?:https?:|data:|blob:)/.test(specifier)) return specifier
  if (/^(?:[./]|[a-zA-Z][\w+.-]*:)/.test(specifier))
    throw new Error(
      `Browser snippets cannot import "${specifier}". Use an HTTPS module URL or an npm package name.`
    )
  return `https://esm.sh/${specifier}`
}

/** Pure compilation; the renderer calls this only in a disposable web worker. */
export function compileBrowserCode(request: BrowserCompileRequest): string {
  const { code, language, resultName, guardName } = request
  for (const name of [resultName, guardName]) {
    if (!/^__jsblitz_[a-zA-Z0-9_]+$/.test(name))
      throw new Error('Invalid browser execution helper name')
  }
  const result = ts.transpileModule(code, {
    fileName: language === 'javascript' ? 'snippet.js' : 'snippet.ts',
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      isolatedModules: true,
      esModuleInterop: true,
      inlineSourceMap: true,
      inlineSources: true,
    },
    reportDiagnostics: true,
    transformers: {
      before: [(context) => (source) => {
        const f = context.factory
        const helper = (name: string, args: ts.Expression[]) =>
          f.createCallExpression(
            f.createElementAccessExpression(f.createIdentifier('globalThis'), f.createStringLiteral(name)),
            undefined,
            args
          )
        const guard = () => f.createExpressionStatement(helper(guardName, []))
        const guardedBody = (body: ts.Statement): ts.Block => {
          const visited = ts.visitNode(body, visit) as ts.Statement
          return f.createBlock([
            guard(),
            ...(ts.isBlock(visited) ? visited.statements : [visited]),
          ], true)
        }
        const visit: ts.Visitor = (node) => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            // Type-only imports disappear; they do not require a browser package.
            if (node.importClause?.isTypeOnly) return node
            return f.updateImportDeclaration(node, node.modifiers, node.importClause,
              f.createStringLiteral(browserSpecifier(node.moduleSpecifier.text)), node.attributes)
          }
          if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            if (node.isTypeOnly) return node
            return f.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause,
              f.createStringLiteral(browserSpecifier(node.moduleSpecifier.text)), node.attributes)
          }
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const specifier = node.arguments[0]
            if (!specifier || !ts.isStringLiteralLike(specifier))
              throw new Error('Browser dynamic imports need a literal HTTPS URL or npm package name.')
            return f.updateCallExpression(node, node.expression, node.typeArguments, [
              f.createStringLiteral(browserSpecifier(specifier.text)),
              ...node.arguments.slice(1),
            ])
          }
          if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
            throw new Error('CommonJS require imports are unavailable in Browser mode. Use an ES import or switch to Node mode.')
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require')
            throw new Error('require() is unavailable in Browser mode. Use an ES import or switch to Node mode.')
          if (ts.isWhileStatement(node))
            return f.updateWhileStatement(node, ts.visitNode(node.expression, visit) as ts.Expression, guardedBody(node.statement))
          if (ts.isDoStatement(node))
            return f.updateDoStatement(node, guardedBody(node.statement), ts.visitNode(node.expression, visit) as ts.Expression)
          if (ts.isForStatement(node))
            return f.updateForStatement(node,
              ts.visitNode(node.initializer, visit) as ts.ForInitializer | undefined,
              ts.visitNode(node.condition, visit) as ts.Expression | undefined,
              ts.visitNode(node.incrementor, visit) as ts.Expression | undefined,
              guardedBody(node.statement))
          if (ts.isForInStatement(node))
            return f.updateForInStatement(node, ts.visitNode(node.initializer, visit) as ts.ForInitializer,
              ts.visitNode(node.expression, visit) as ts.Expression, guardedBody(node.statement))
          if (ts.isForOfStatement(node))
            return f.updateForOfStatement(node, node.awaitModifier,
              ts.visitNode(node.initializer, visit) as ts.ForInitializer,
              ts.visitNode(node.expression, visit) as ts.Expression, guardedBody(node.statement))
          return ts.visitEachChild(node, visit, context)
        }
        const statements = source.statements.map((statement) => {
          const visited = ts.visitNode(statement, visit) as ts.Statement
          if (!ts.isExpressionStatement(visited)) return visited
          if (ts.isStringLiteral(visited.expression) && ['use strict', 'use asm'].includes(visited.expression.text))
            return visited
          const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1
          const call = helper(resultName, [visited.expression, f.createNumericLiteral(line)])
          ts.setTextRange(call, statement)
          return f.updateExpressionStatement(visited, call)
        })
        return f.updateSourceFile(source, statements)
      }],
    },
  })
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors?.length)
    throw new SyntaxError(errors.map((error) => {
      const line = error.file && error.start !== undefined
        ? ` (line ${error.file.getLineAndCharacterOfPosition(error.start).line + 1})` : ''
      return ts.flattenDiagnosticMessageText(error.messageText, '\n') + line
    }).join('\n'))
  return result.outputText + '\n//# sourceURL=jsblitz-browser-snippet.js\n'
}
