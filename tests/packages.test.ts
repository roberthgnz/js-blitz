import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import {
  ensurePackages,
  getPackages,
  packageRoot,
} from '../electron/lib/packages'

const tick = String.fromCharCode(96)

test('package roots normalize scopes, subpaths and registry versions', () => {
  for (const [specifier, expected] of [
    ['lodash', 'lodash'],
    ['lodash/fp', 'lodash'],
    ['@scope/package', '@scope/package'],
    ['@scope/package/deep/file.js', '@scope/package'],
    ['dayjs@1.11.13', 'dayjs'],
    ['@scope/package@^2.0.0', '@scope/package'],
    ['dayjs@>=1 <2', 'dayjs'],
  ]) {
    assert.equal(packageRoot(specifier), expected, specifier)
  }
  for (const specifier of [
    '',
    'fs',
    'fs/promises',
    'node:fs',
    'node:test',
    'node:sqlite',
    'path/posix',
    './file.js',
    '../file.js',
    '/absolute/file.js',
    'C:\\absolute\\file.js',
    '\\\\server\\file.js',
    'https://example.com/module.js',
    'file:../module.js',
    'data:text/javascript,export default 1',
    '#local-alias',
    '@scope',
    '@scope/',
    'pkg@',
    '--flag',
    '_invalid',
    ' pkg',
    'pkg/../escape',
    '@scope/../escape',
    'pkg?query',
  ]) {
    assert.equal(packageRoot(specifier), null, specifier)
  }
})

test('AST finds runtime imports, reexports and literal calls in source order', () => {
  const code = [
    'import value from "default-package/subpath"',
    'import "side-effect-package"',
    'import * as namespace from "@scope/namespace/deep"',
    'export { value } from "reexport-package"',
    'export * from "@scope/reexport/subpath"',
    'export * as values from "namespace-export"',
    'const lazy = import("dynamic-package/feature")',
    'const options = import("import-options", { with: { type: "json" } })',
    'const cjs = require("require-package/deep")',
    'const template = require(' + tick + 'template-package' + tick + ')',
    'const templateImport = import(' + tick + 'template-import' + tick + ')',
    'import legacy = require("legacy-package")',
    'require("default-package/another-subpath")',
  ].join('\n')
  assert.deepEqual(getPackages(code), [
    'default-package',
    'side-effect-package',
    '@scope/namespace',
    'reexport-package',
    '@scope/reexport',
    'namespace-export',
    'dynamic-package',
    'import-options',
    'require-package',
    'template-package',
    'template-import',
    'legacy-package',
  ])
  assert.deepEqual(getPackages(code), getPackages(code))
})

test('AST excludes comments, string decoys, computed calls and builtin/local imports', () => {
  assert.deepEqual(
    getPackages(
      [
        '// import x from "comment-package"',
        '/* require("block-comment-package"); import("comment-dynamic") */',
        'const string = \'require("string-package")\'',
        'const template = ' + tick + 'import("template-decoy")' + tick,
        'const regex = /require\\("regex-decoy"\\)/',
        'require(variable)',
        'import("computed-" + variable)',
        'require(' + tick + 'computed-' + '$' + '{variable}' + tick + ')',
        'other.require("property-call")',
        'require.resolve("resolved-only")',
        'import "fs/promises"',
        'import "node:test"',
        'import "./local.js"',
        'require("../relative.js")',
        'import("https://example.com/module.js")',
        'require("actual-package")',
      ].join('\n')
    ),
    ['actual-package']
  )
})

test('AST skips type-only dependencies and retains mixed and empty runtime declarations', () => {
  assert.deepEqual(
    getPackages(
      [
        'import type { A } from "type-import"',
        'import { type A, type B as C } from "inline-types"',
        'export type { A } from "type-export"',
        'export type * from "type-star"',
        'export { type A, type B } from "inline-type-export"',
        'import type Legacy = require("type-require")',
        'type T = import("import-type").T',
        'import { type A, runtime } from "mixed-import"',
        'import Default, { type A } from "default-and-type"',
        'export { type A, runtime } from "mixed-export"',
        'import {} from "empty-import"',
        'export {} from "empty-export"',
      ].join('\n')
    ),
    [
      'mixed-import',
      'default-and-type',
      'mixed-export',
      'empty-import',
      'empty-export',
    ]
  )
})

// Real npm installs use a local registry and minimal POSIX tar fixtures.
function tarball(files: Record<string, string>) {
  const chunks: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write('package/' + name, 0, 100)
    header.write('0000644\0', 100, 8)
    header.write('0000000\0', 108, 8)
    header.write('0000000\0', 116, 8)
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12)
    header.write('00000000000\0', 136, 12)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257, 6)
    header.write('00', 263, 2)
    const checksum = header.reduce((total, byte) => total + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

test('npm installer resolves real packages and serializes workspace mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'js-blitz-packages-'))
  const rootName = '@js-blitz-test/runtime'
  const childName = 'js-blitz-test-dependency'
  const secondName = 'js-blitz-test-second'
  const versions = new Map<string, Record<string, unknown>[]>()
  const archives = new Map<string, Buffer>()
  for (const [name, available] of [
    [rootName, ['1.0.0', '2.0.0']],
    [childName, ['1.0.0', '2.0.0']],
    [secondName, ['1.0.0']],
  ] as const) {
    versions.set(
      name,
      available.map((version) => {
        const manifest = {
          name,
          version,
          exports: { '.': './index.js', './subpath': './subpath.js' },
          scripts: {
            postinstall:
              "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'yes')\"",
          },
          ...(name === rootName
            ? { dependencies: { [childName]: '^' + version } }
            : {}),
        }
        const entry =
          name === rootName
            ? 'module.exports = require(' +
              JSON.stringify(childName) +
              ') + ' +
              JSON.stringify(':' + version)
            : 'module.exports = ' + JSON.stringify(name + ':' + version)
        archives.set(
          name + '@' + version,
          tarball({
            'package.json': JSON.stringify(manifest),
            'index.js': entry,
            'subpath.js': 'module.exports = "subpath"',
          })
        )
        return manifest
      })
    )
  }

  let registry = ''
  const server = createServer((request, response) => {
    const path = decodeURIComponent(
      new URL(request.url || '/', registry).pathname.slice(1)
    )
    if (path.startsWith('tarballs/')) {
      const archive = archives.get(path.slice('tarballs/'.length))
      response.writeHead(archive ? 200 : 404, {
        'content-type': 'application/octet-stream',
      })
      response.end(archive)
      return
    }
    const manifests = versions.get(path)
    response.writeHead(manifests ? 200 : 404, {
      'content-type': 'application/json',
    })
    response.end(
      JSON.stringify(
        manifests
          ? {
              name: path,
              'dist-tags': { latest: manifests[manifests.length - 1].version },
              versions: Object.fromEntries(
                manifests.map((manifest) => [
                  manifest.version,
                  {
                    ...manifest,
                    dist: {
                      tarball:
                        registry +
                        'tarballs/' +
                        encodeURIComponent(path + '@' + manifest.version),
                    },
                  },
                ])
              ),
            }
          : { error: 'package not found' }
      )
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  registry = 'http://127.0.0.1:' + address.port + '/'
  const previousRegistry = process.env.npm_config_registry
  const previousCache = process.env.npm_config_cache
  process.env.npm_config_registry = registry
  process.env.npm_config_cache = join(directory, 'cache')
  t.after(async () => {
    if (previousRegistry === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = previousRegistry
    if (previousCache === undefined) delete process.env.npm_config_cache
    else process.env.npm_config_cache = previousCache
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  })

  const workspace = join(directory, 'workspace')
  const statuses: string[] = []
  const onStatus = ({ status }: { status: string }) => statuses.push(status)
  const manifest = () =>
    readFile(join(workspace, 'package.json'), 'utf8').then(JSON.parse)

  await t.test(
    'installs a pinned scoped package, subpath and transitive dependency',
    async () => {
      await mkdir(workspace)
      await writeFile(
        join(workspace, 'package.json'),
        JSON.stringify({
          name: 'existing-workspace',
          private: true,
          custom: 'kept',
        })
      )
      await ensurePackages(
        workspace,
        [rootName + '@1.0.0', rootName + '/subpath', rootName],
        { onStatus }
      )
      assert.deepEqual(statuses, [
        'package-installation-started',
        'package-installation-finished',
      ])
      const require = createRequire(join(workspace, 'package.json'))
      assert.equal(require(rootName), childName + ':1.0.0:1.0.0')
      assert.equal(require(rootName + '/subpath'), 'subpath')
      await assert.rejects(
        stat(join(workspace, 'node_modules', rootName, 'lifecycle-ran')),
        { code: 'ENOENT' }
      )
      assert.equal((await manifest()).custom, 'kept')
      assert.equal((await manifest()).dependencies[rootName], '1.0.0')
      assert.equal(
        JSON.parse(await readFile(join(workspace, 'package-lock.json'), 'utf8'))
          .packages['node_modules/' + childName].version,
        '1.0.0'
      )
    }
  )

  await t.test(
    'skips compatible installed ranges without installation statuses',
    async () => {
      statuses.length = 0
      await ensurePackages(workspace, [rootName + '@>=1 <2', 'node:fs'], {
        onStatus,
      })
      assert.deepEqual(statuses, [])
    }
  )

  await t.test(
    'resolves explicit tags and replaces incompatible versions',
    async () => {
      await ensurePackages(workspace, [rootName + '@latest'], { onStatus })
      assert.equal(
        JSON.parse(
          await readFile(
            join(workspace, 'node_modules', rootName, 'package.json'),
            'utf8'
          )
        ).version,
        '2.0.0'
      )
      await ensurePackages(workspace, [rootName, rootName + '@1.0.0'], {
        onStatus,
      })
      assert.equal((await manifest()).dependencies[rootName], '1.0.0')
    }
  )

  await t.test(
    'preserves cached explicit transitive constraints during another install',
    async () => {
      const constrainedWorkspace = join(directory, 'constraints')
      await ensurePackages(constrainedWorkspace, [rootName + '@1.0.0'])
      await ensurePackages(constrainedWorkspace, [
        rootName + '@2.0.0',
        childName + '@1.0.0',
      ])
      const require = createRequire(join(constrainedWorkspace, 'package.json'))
      assert.equal(require(childName), childName + ':1.0.0')
      assert.equal(require(rootName), childName + ':2.0.0:2.0.0')
    }
  )

  await t.test(
    'keeps cached bare packages at their installed versions',
    async () => {
      await ensurePackages(workspace, [rootName, secondName])
      assert.equal((await manifest()).dependencies[rootName], '1.0.0')
    }
  )

  await t.test(
    'serializes competing installs and rechecks the installed tree',
    async () => {
      const concurrentWorkspace = join(directory, 'concurrent')
      statuses.length = 0
      await Promise.all([
        ensurePackages(concurrentWorkspace, [rootName + '@1.0.0'], {
          onStatus,
        }),
        ensurePackages(concurrentWorkspace, [secondName + '@1.0.0'], {
          onStatus,
        }),
        ensurePackages(concurrentWorkspace, [rootName + '@1.0.0'], {
          onStatus,
        }),
      ])
      assert.deepEqual(statuses, [
        'package-installation-started',
        'package-installation-finished',
        'package-installation-started',
        'package-installation-finished',
      ])
      const saved = JSON.parse(
        await readFile(join(concurrentWorkspace, 'package.json'), 'utf8')
      )
      assert.equal(saved.dependencies[rootName], '1.0.0')
      assert.equal(saved.dependencies[secondName], '1.0.0')
      assert.deepEqual(
        (await readdir(concurrentWorkspace)).filter((name) =>
          name.startsWith('.js-blitz-package-install.lock')
        ),
        []
      )
    }
  )

  await t.test(
    'failed installation releases ownership and never reports finished',
    async () => {
      const failingWorkspace = join(directory, 'failure')
      statuses.length = 0
      await assert.rejects(
        ensurePackages(failingWorkspace, ['js-blitz-test-not-found'], {
          onStatus,
        }),
        /404|not found/
      )
      assert.deepEqual(statuses, ['package-installation-started'])
      await ensurePackages(failingWorkspace, [secondName], { onStatus })
      assert.ok(
        await stat(
          join(failingWorkspace, 'node_modules', secondName, 'index.js')
        )
      )
    }
  )

  await t.test(
    'rejects aliases rather than fetching a different package',
    async () => {
      await assert.rejects(
        ensurePackages(workspace, ['alias@npm:' + secondName]),
        /Unsupported package specifier/
      )
    }
  )
})

test('a pre-aborted installation performs no filesystem mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'js-blitz-aborted-'))
  try {
    const workspace = join(directory, 'untouched')
    await assert.rejects(
      ensurePackages(workspace, ['package'], {
        signal: AbortSignal.abort(),
      }),
      { name: 'AbortError' }
    )
    await assert.rejects(stat(workspace), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('waiting cancellation preserves a live owner and removes its own candidate', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'js-blitz-live-lock-'))
  const lock = join(workspace, '.js-blitz-package-install.lock')
  const owner = 'owner-' + process.pid + '-' + randomUUID()
  try {
    await mkdir(lock)
    await writeFile(join(lock, owner), '')
    await assert.rejects(
      ensurePackages(workspace, [], {
        signal: AbortSignal.timeout(100),
      }),
      { name: 'AbortError' }
    )
    assert.deepEqual(await readdir(lock), [owner])
    assert.deepEqual(await readdir(workspace), [
      '.js-blitz-package-install.lock',
    ])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('competing installers recover a terminated worker lock', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'js-blitz-dead-lock-'))
  try {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          'const fs = require("node:fs")',
          'const path = require("node:path")',
          'const crypto = require("node:crypto")',
          'const lock = path.join(process.argv[1], ".js-blitz-package-install.lock")',
          'fs.mkdirSync(lock)',
          'fs.writeFileSync(path.join(lock, "owner-" + process.pid + "-" + crypto.randomUUID()), "")',
          'process.stdout.write("ready")',
          'setInterval(() => {}, 1000)',
        ].join(';'),
        workspace,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const exited = once(child, 'exit')
    await once(child.stdout, 'data')
    child.kill()
    await exited
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ensurePackages(workspace, []))
    )
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
    }
    assert.equal(
      JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'))
        .private,
      true
    )
    assert.deepEqual(await readdir(workspace), ['package.json'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
