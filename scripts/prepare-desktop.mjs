import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const runtime = path.join(root, 'src-tauri', 'resources', 'desktop')
const binaries = path.join(root, 'src-tauri', 'binaries')
const hostTargets = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}
const host = hostTargets[`${process.platform}-${process.arch}`]
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || host

if (!host || target !== host) {
  throw new Error(
    `Prepare the bundled Node runtime on its native build host (${target || process.platform}). Cross-target Node binaries are not substituted automatically.`
  )
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error(
    'JSBlitz requires Node.js 22 or newer to prepare its bundled runtime.'
  )
}

await mkdir(runtime, { recursive: true })
await mkdir(binaries, { recursive: true })

async function hashFile(filename) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename)) digest.update(chunk)
  return digest.digest('hex')
}

const nodeBinary = path.join(
  binaries,
  `jsblitz-node-${target}${process.platform === 'win32' ? '.exe' : ''}`
)
const sourceNode = await realpath(process.execPath)
const nodeHash = await hashFile(sourceNode)
const existingHash = await hashFile(nodeBinary).catch(() => '')
if (nodeHash !== existingHash) await copyFile(sourceNode, nodeBinary)
if (process.platform !== 'win32') await chmod(nodeBinary, 0o755)

const dependencyVersions = {}
for (const name of ['npm', 'typescript']) {
  const manifest = await realpath(require.resolve(`${name}/package.json`))
  const source = path.dirname(manifest)
  const destination = path.join(runtime, 'node_modules', name)
  const { version } = JSON.parse(await readFile(manifest, 'utf8'))
  const installedVersion = await readFile(
    path.join(destination, 'package.json'),
    'utf8'
  )
    .then((value) => JSON.parse(value).version)
    .catch(() => null)
  if (installedVersion !== version) {
    const resolvedDestination = path.resolve(destination)
    if (!resolvedDestination.startsWith(path.resolve(runtime) + path.sep))
      throw new Error('Invalid generated dependency destination')
    await rm(resolvedDestination, { recursive: true, force: true })
    await cp(source, destination, { recursive: true, dereference: true })
  }
  dependencyVersions[name] = version
}

await writeFile(
  path.join(runtime, 'package.json'),
  JSON.stringify(
    { name: 'jsblitz-desktop-runtime', private: true, type: 'commonjs' },
    null,
    2
  ) + '\n'
)
await build({
  configFile: false,
  root,
  build: {
    outDir: runtime,
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    lib: {
      entry: {
        service: path.join(root, 'desktop', 'service.ts'),
        'execution-worker': path.join(
          root,
          'desktop',
          'lib',
          'execution-worker.ts'
        ),
      },
      formats: ['cjs'],
      fileName: (_format, name) => `${name}.cjs`,
    },
    rollupOptions: {
      external: [...builtinModules, /^node:/, 'typescript', 'npm'],
      output: { chunkFileNames: '[name]-[hash].cjs' },
    },
  },
})

const runtimeRequire = createRequire(path.join(runtime, 'package.json'))
const npmRequire = createRequire(runtimeRequire.resolve('npm/package.json'))
npmRequire.resolve('@npmcli/arborist')
runtimeRequire.resolve('typescript')
for (const entry of ['service.cjs', 'execution-worker.cjs'])
  await stat(path.join(runtime, entry))
await writeFile(
  path.join(runtime, 'runtime-manifest.json'),
  JSON.stringify(
    {
      target,
      node: { version: process.versions.node, sha256: nodeHash },
      dependencies: dependencyVersions,
    },
    null,
    2
  ) + '\n'
)
console.log(
  `Prepared ${target} desktop runtime with bundled Node ${process.versions.node}.`
)
