import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import {
  cancelExecution,
  configureRunner,
  executeCode,
  type RunnerOutput,
} from '../electron/lib/coderunner'

let workspacePath: string
const workerPath =
  process.env.JSBLITZ_TEST_WORKER ||
  path.resolve('electron/lib/execution-worker.ts')

before(async () => {
  workspacePath = await mkdtemp(path.join(tmpdir(), 'jsblitz-runner-test-'))
  configureRunner({ workspacePath, workerPath })
  for (const [name, manifest, files] of [
    [
      'runner-esm-fixture',
      {
        type: 'module',
        exports: { '.': './index.js', './feature': './feature.js' },
      },
      {
        'index.js':
          'export default (value) => value * 2; export const flavor = "esm";',
        'feature.js': 'export const answer = 42;',
      },
    ],
    [
      'runner-cjs-fixture',
      { main: './index.js' },
      { 'index.js': 'module.exports = { answer: 21 };' },
    ],
  ] as const) {
    const folder = path.join(workspacePath, 'node_modules', name)
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...manifest })
    )
    for (const [file, source] of Object.entries(files))
      await writeFile(path.join(folder, file), source)
  }
})

after(async () => {
  await rm(workspacePath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

test('captures TypeScript bare expressions with their original source lines', async () => {
  const statuses: string[] = []
  const response = await executeCode(
    { code: 'const answer: number = 40\nanswer + 2', language: 'typescript' },
    ({ status }) => statuses.push(status)
  )
  assert.equal(response.success, true, response.error)
  assert.deepEqual(response.output, [
    { type: 'result', value: ['42'], line: 2 },
  ])
  assert.deepEqual(statuses, [
    'code-execution-started',
    'code-execution-finished',
  ])
})

test('supports require, Node globals, env, native fetch, static imports and top-level await', async () => {
  const response = await executeCode({
    code: `import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
await delay(5)
console.log(basename('/tmp/demo.js'), require('node:os').platform(), Buffer.from('ok').toString(), process.env.JSBLITZ_TEST_ENV)
await (await fetch('data:text/plain,hello')).text()`,
    env: { JSBLITZ_TEST_ENV: 'provided' },
  })
  assert.equal(response.success, true, response.error)
  assert.deepEqual(response.output[0], {
    type: 'log',
    value: ['demo.js', process.platform, 'ok', 'provided'],
  })
  assert.deepEqual(response.output.at(-1)?.value, ['hello'])
})

test('captures bare strings, objects and promises without evaluating expressions twice', async () => {
  const response = await executeCode({
    code: `'hello';\n({ value: 42 });\nlet count = 0\n++count\ncount\nPromise.resolve(42)`,
  })
  assert.equal(response.success, true, response.error)
  assert.deepEqual(
    response.output.slice(0, 4).map((entry) => entry.value),
    [['hello'], ['{ value: 42 }'], ['1'], ['1']]
  )
  assert.match(response.output.at(-1)!.value[0], /Promise/)
})

test('loads CJS, ESM-only and npm export-map subpaths using the workspace', async () => {
  const response = await executeCode({
    code: `import twice from 'runner-esm-fixture'
import common from 'runner-cjs-fixture'
const { answer } = await import('runner-esm-fixture/feature')
console.log(twice(common.answer), answer, require('runner-cjs-fixture').answer)`,
  })
  assert.equal(response.success, true, response.error)
  assert.deepEqual(response.output, [
    { type: 'log', value: ['42', '42', '21'] },
  ])
})

test('serializes circular objects, BigInt, Map, Error, and throwing inspect/toJSON safely', async () => {
  const response = await executeCode({
    code: `const circular = { count: 2n }; circular.self = circular
console.log(circular, new Map([['x', 1]]), new Error('visible'), { toJSON() { throw Error('no') }, [Symbol.for('nodejs.util.inspect.custom')]() { throw Error('no') } })`,
  })
  assert.equal(response.success, true, response.error)
  const values = response.output.find((entry) => entry.type === 'log')!.value
  assert.match(values[0], /Circular/)
  assert.match(values[0], /2n/)
  assert.match(values[1], /Map/)
  assert.match(values[2], /Error: visible/)
  assert.match(values[3], /toJSON/)
})

test('streams logs before completion and waits for unawaited asynchronous timers', async () => {
  const streamed: RunnerOutput[] = []
  let finished = false
  const responsePromise = executeCode(
    {
      code: `console.log('first'); setTimeout(() => console.log('later'), 80); void 0`,
    },
    undefined,
    (entry) => {
      assert.equal(finished, false)
      streamed.push(entry)
    }
  )
  const response = await responsePromise
  finished = true
  assert.equal(response.success, true, response.error)
  assert.deepEqual(streamed, response.output)
  assert.deepEqual(
    response.output
      .filter((entry) => entry.type === 'log')
      .map((entry) => entry.value),
    [['first'], ['later']]
  )
})

test('utility-process transport finishes after user timers despite its persistent host handle', async () => {
  const shimPath = path.join(workspacePath, 'utility-transport.cjs')
  const loaderPath = createRequire(__filename).resolve('tsx/cjs')
  await writeFile(
    shimPath,
    `require(${JSON.stringify(loaderPath)});
setInterval(() => {}, 60000);
process.parentPort = {
  once(event, listener) { process.once(event, data => listener({ data })); },
  postMessage(message) { process.send(message); }
};
require(${JSON.stringify(workerPath)});`
  )
  configureRunner({ workspacePath, workerPath: shimPath })
  try {
    const response = await executeCode({
      code: `console.log('start'); setTimeout(() => console.log('drained'), 80)`,
      timeoutMs: 5000,
    })
    assert.equal(response.success, true, response.error)
    assert.deepEqual(
      response.output
        .filter((entry) => entry.type === 'log')
        .map((entry) => entry.value),
      [['start'], ['drained']]
    )
  } finally {
    configureRunner({ workspacePath, workerPath })
  }
})

test('retains output and finishes status exactly once when code throws', async () => {
  const statuses: string[] = []
  const response = await executeCode(
    { code: `console.warn('before'); throw new Error('boom')` },
    ({ status }) => statuses.push(status)
  )
  assert.equal(response.success, false)
  assert.equal(response.error, 'boom')
  assert.deepEqual(response.output[0], { type: 'warn', value: ['before'] })
  assert.equal(response.output.at(-1)?.type, 'error')
  assert.equal(
    statuses.filter((status) => status === 'code-execution-finished').length,
    1
  )
})

test('captures exceptions thrown later by timers', async () => {
  const response = await executeCode({
    code: `console.log('before'); setTimeout(() => { throw Error('later error') }, 10)`,
  })
  assert.equal(response.success, false)
  assert.equal(response.error, 'later error')
  assert.deepEqual(response.output[0].value, ['before'])
})

test('hard timeout kills infinite loops and preserves earlier streamed output', async () => {
  const response = await executeCode({
    code: `console.log('before loop'); while (true) {}`,
    timeoutMs: 2500,
  })
  assert.equal(response.success, false)
  assert.match(response.error!, /timed out/)
  assert.deepEqual(response.output[0]?.value, ['before loop'])
  assert.equal((await executeCode({ code: '21 * 2' })).success, true)
})

test('cancellation terminates timer work without leaving files or pending executions', async () => {
  const marker = path.join(workspacePath, 'must-not-exist.txt')
  const runId = randomUUID()
  let streamed!: () => void
  const started = new Promise<void>((resolve) => {
    streamed = resolve
  })
  const pending = executeCode(
    {
      runId,
      code: `const fs = require('node:fs'); console.log('ready'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'bad'), 1000)`,
    },
    undefined,
    (entry) => {
      if (entry.type === 'log') streamed()
    }
  )
  await started
  cancelExecution(runId)
  const response = await pending
  assert.equal(response.success, false)
  assert.match(response.error!, /cancelled/)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(existsSync(marker), false)
  assert.equal((await executeCode({ runId, code: '42' })).success, true)
})

test('isolation prevents globals and environment values leaking between runs', async () => {
  await executeCode({
    code: `globalThis.testLeak = 1; process.env.JSBLITZ_LEAK = 'bad'`,
  })
  const response = await executeCode({
    code: `console.log(typeof globalThis.testLeak, process.env.JSBLITZ_LEAK)`,
  })
  assert.equal(response.success, true, response.error)
  assert.deepEqual(response.output[0]?.value, ['undefined', 'undefined'])
})

test('invalid syntax and unresolved top-level await return failures', async () => {
  assert.equal((await executeCode({ code: 'const = broken' })).success, false)
  const pending = await executeCode({
    code: 'await new Promise(() => {})',
    timeoutMs: 2500,
  })
  assert.equal(pending.success, false)
  assert.match(pending.error!, /unresolved top-level await|timed out/)
})

test('survives renderer callback failures', async () => {
  const response = await executeCode(
    { code: `console.log('ok')` },
    () => {
      throw Error('renderer closed')
    },
    () => {
      throw Error('renderer closed')
    }
  )
  assert.equal(response.success, true, response.error)
  assert.deepEqual(response.output[0]?.value, ['ok'])
})
