import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { builtinModules, createRequire, isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import ts from 'typescript'

const builtins = new Set(builtinModules.map((name) => name.split('/')[0]))
const packageName = /^(?:@[a-z0-9_~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i

/** Return a registry package's root, excluding paths, URLs and Node builtins. */
export function packageRoot(specifier: string): string | null {
  if (!specifier || /[\\:%?#]/.test(specifier)) return null

  const parts = specifier.split('/')
  const scoped = specifier.startsWith('@')
  const name = scoped ? parts.slice(0, 2).join('/') : parts[0]
  const versionAt = name.indexOf('@', scoped ? 1 : 0)
  const root = versionAt === -1 ? name : name.slice(0, versionAt)

  if (
    !packageName.test(root) ||
    (versionAt !== -1 && !name.slice(versionAt + 1)) ||
    parts.some((part) => part === '.' || part === '..') ||
    isBuiltin(root) ||
    builtins.has(root)
  ) {
    return null
  }

  return root
}

/** Find literal runtime dependencies without matching comments or string contents. */
export function getPackages(script: string): string[] {
  const source = ts.createSourceFile(
    'snippet.ts',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const packages = new Set<string>()
  const add = (node: ts.Node | undefined) => {
    if (
      node &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      const root = packageRoot(node.text)
      if (root) packages.add(root)
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const onlyTypes =
        clause?.isTypeOnly ||
        (!clause?.name &&
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly))
      if (!onlyTypes) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      const onlyTypes =
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly))
      if (!onlyTypes) add(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      add(node.arguments[0])
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return [...packages]
}

export interface EnsurePackagesOptions {
  signal?: AbortSignal
  onStatus?: (status: {
    status: 'package-installation-started' | 'package-installation-finished'
  }) => void
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code

/**
 * Atomically rename a populated directory so ownership is never half-written.
 * Each owner has a unique file: competing stale-lock recoveries cannot remove
 * the next owner's file, and rmdir cannot remove its populated directory.
 */
async function acquireInstallLock(workspace: string, signal?: AbortSignal) {
  const lock = join(workspace, '.js-blitz-package-install.lock')
  const owner = `owner-${process.pid}-${randomUUID()}`
  const candidate = `${lock}.${owner}`
  await mkdir(candidate)
  try {
    await writeFile(join(candidate, owner), '')
    const deadline = Date.now() + 120_000
    for (;;) {
      signal?.throwIfAborted()
      try {
        await rename(candidate, lock)
        return async () => {
          await unlink(join(lock, owner))
          // A waiter can reclaim the now-empty directory before this rmdir,
          // or already replace it with its own populated directory.
          await rmdir(lock).catch((error: unknown) => {
            if (
              !['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(
                errorCode(error) || ''
              )
            ) {
              throw error
            }
          })
        }
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(
            errorCode(error) || ''
          )
        ) {
          throw error
        }
      }

      try {
        const owners = await readdir(lock)
        for (const entry of owners) {
          const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(entry)
          if (!match || Number(match[1]) <= 0 || Number(match[1]) > 2 ** 31 - 1)
            continue
          try {
            process.kill(Number(match[1]), 0)
          } catch (error) {
            if (errorCode(error) === 'ESRCH') {
              await unlink(join(lock, entry)).catch((error: unknown) => {
                if (
                  !['ENOENT', 'EPERM', 'EACCES'].includes(
                    errorCode(error) || ''
                  )
                )
                  throw error
              })
            }
          }
        }
        // An empty directory can remain if its owner dies while releasing it.
        await rmdir(lock).catch((error: unknown) => {
          if (
            !['ENOTEMPTY', 'EEXIST', 'ENOENT', 'EPERM', 'EACCES'].includes(
              errorCode(error) || ''
            )
          ) {
            throw error
          }
        })
      } catch (error) {
        if (!['ENOENT', 'EPERM', 'EACCES'].includes(errorCode(error) || ''))
          throw error
      }

      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting for package installation in this workspace'
        )
      }
      await delay(50, undefined, { signal })
    }
  } finally {
    // After a successful rename the candidate no longer exists.
    await unlink(join(candidate, owner)).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
    await rmdir(candidate).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  }
}

interface PackageManifest {
  name?: string
  version?: string
}

/**
 * Install with npm's own dependency resolver. Call this in the Node execution
 * worker: killing that worker also stops installation, without launching the
 * Electron executable as though it were a standalone node binary.
 * Installation scripts are disabled; packages requiring postinstall setup or
 * native compilation need to be prepared separately.
 */
export async function ensurePackages(
  workspacePath: string,
  packages: string[],
  options: EnsurePackagesOptions = {}
): Promise<void> {
  const { signal, onStatus } = options
  signal?.throwIfAborted()
  const workspace = resolve(workspacePath)
  await mkdir(workspace, { recursive: true })
  const release = await acquireInstallLock(workspace, signal)
  try {
    signal?.throwIfAborted()
    const manifestPath = join(workspace, 'package.json')
    await writeFile(
      manifestPath,
      JSON.stringify(
        { name: 'js-blitz-workspace', version: '1.0.0', private: true },
        null,
        2
      ) + '\n',
      { flag: 'wx' }
    ).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error
    })

    const requests = new Map<string, string>()
    for (const specifier of packages) {
      const root = packageRoot(specifier)
      if (!root) {
        if (
          /^(?:@[a-z0-9_~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*@/i.test(
            specifier
          )
        ) {
          throw new Error(`Unsupported package specifier: ${specifier}`)
        }
        continue
      }
      const requested = specifier.startsWith(`${root}@`) ? specifier : root
      // A bare import discovered in the AST must not erase an explicit version.
      if (!requests.has(root) || requested !== root)
        requests.set(root, requested)
    }
    if (!requests.size) return

    // Keep npm and its internals out of module initialization and the main process.
    const require = createRequire(__filename)
    const npmRequire = createRequire(require.resolve('npm/package.json'))
    const semver = npmRequire('semver') as {
      validRange: (range: string) => string | null
      satisfies: (version: string, range: string) => boolean
    }
    const parse = npmRequire('npm-package-arg') as (specifier: string) => {
      type: string
      rawSpec: string
    }
    const missing: string[] = []
    const installRequests = new Map(requests)
    for (const [root, requested] of requests) {
      const parsed = parse(requested)
      if (!['version', 'range', 'tag'].includes(parsed.type)) {
        throw new Error(`Invalid registry package: ${requested}`)
      }
      try {
        const installed = JSON.parse(
          await readFile(
            join(workspace, 'node_modules', root, 'package.json'),
            'utf8'
          )
        ) as PackageManifest
        if (
          installed.version &&
          (requested === root ||
            (semver.validRange(parsed.rawSpec) &&
              semver.satisfies(installed.version, parsed.rawSpec)))
        ) {
          if (requested === root) {
            // Preserve the cached version while adding other dependencies.
            installRequests.set(root, `${root}@${installed.version}`)
          }
          continue
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError))
          throw error
      }
      missing.push(requested)
    }
    signal?.throwIfAborted()
    if (!missing.length) return

    const Arborist = npmRequire('@npmcli/arborist') as new (
      options: Record<string, unknown>
    ) => { reify: (options: Record<string, unknown>) => Promise<unknown> }
    onStatus?.({ status: 'package-installation-started' })
    const installer = new Arborist({
      path: workspace,
      registry:
        process.env.npm_config_registry ||
        process.env.NPM_CONFIG_REGISTRY ||
        'https://registry.npmjs.org/',
      audit: false,
      fund: false,
      // Lifecycle subprocesses could survive a killed worker and keep mutating
      // the workspace after its filesystem lock is reclaimed.
      ignoreScripts: true,
      savePrefix: '',
      cache: process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE,
      signal,
    })
    await installer.reify({
      add: [...installRequests.values()],
      save: true,
      signal,
    })
    signal?.throwIfAborted()
    onStatus?.({ status: 'package-installation-finished' })
  } finally {
    await release()
  }
}
