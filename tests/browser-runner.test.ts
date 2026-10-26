import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

import { compileBrowserCode } from '../src/lib/browser-compiler'
import { createBrowserExecution } from '../src/lib/browser-runner'
import type { ExecuteResponse, Output } from '../types'

const resultName = '__jsblitz_test_result'
const guardName = '__jsblitz_test_guard'
const compile = (code: string, language: 'javascript' | 'typescript' = 'javascript') =>
  compileBrowserCode({ code, language, resultName, guardName })

test('browser compiler preserves modern TS, await and original expression lines without double evaluation', async () => {
  const output: unknown[][] = []
  const context = vm.createContext({
    [resultName]: (value: unknown, line: number) => { output.push([value, line]); return value },
    [guardName]: (): void => undefined,
  })
  await vm.runInContext(`(async () => { ${compile(`type Shape = { count: number }
const value = { count: 0 } satisfies Shape
++value.count
await Promise.resolve(value.count + 41)
value.count`, 'typescript')} })()`, context)
  assert.deepEqual(output, [[1, 3], [42, 4], [1, 5]])
})

test('browser compiler guards nested and single-statement loops and preserves loop semantics', () => {
  let checks = 0
  const results: unknown[] = []
  const context = vm.createContext({
    [resultName]: (value: unknown) => results.push(value),
    [guardName]: () => { if (++checks > 25) throw Error('guard stopped execution') },
  })
  vm.runInContext(compile(`let count = 0
for (let i = 0; i < 2; i++) count++
for (const item of [1, 2]) { count += item }
for (const key in { a: 1 }) count++
do { count++ } while (count < 8)
while (count < 10) count++
count`), context)
  assert.equal(results.at(-1), 10)
  assert.ok(checks >= 9)
  assert.throws(() => vm.runInContext(compile('function spin() { while (true) {} }; spin()'), context), /guard stopped/)
})

test('browser compiler rewrites browser imports and clearly rejects Node and unsupported local imports', () => {
  const source = compile(`import { chunk } from 'lodash-es'
const remote = await import('https://example.com/module.js')
console.log(chunk, remote)`)
  assert.match(source, /https:\/\/esm.sh\/lodash-es/)
  assert.match(source, /https:\/\/example.com\/module.js/)
  assert.doesNotThrow(() => compile("import type { Buffer } from 'node:buffer'; const value: number = 42; value", 'typescript'))
  for (const source of ["import fs from 'node:fs'; console.log(fs)", "await import('fs/promises')"])
    assert.throws(() => compile(source), /Node module.*Browser mode/)
  assert.throws(() => compile("require('lodash')"), /require\(\).*Browser mode/)
  assert.throws(() => compile("await import('./local.js')"), /HTTPS module URL/)
  assert.throws(() => compile('const name = "pkg"; await import(name)'), /literal HTTPS URL/)
  assert.throws(() => compile('const = broken'), /line 1/)
})

class FakeFrame extends EventTarget {
  attributes = new Map<string, string>()
  title = ''
  src = ''
  removed = false
  remotePort?: MessagePort
  received: unknown[] = []
  contentWindow = {
    postMessage: (message: { runId: string }, _origin: string, ports: MessagePort[]) => {
      this.remotePort = ports[0]
      this.remotePort.onmessage = ({ data }) => { this.received.push(data) }
      this.remotePort.start()
      this.remotePort.postMessage({ kind: 'ready', runId: message.runId })
    },
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  remove() { this.removed = true }
}

class FakeCompilerWorker {
  static instances: FakeCompilerWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: (event: { message: string; preventDefault(): void }) => void
  terminated = false
  message?: unknown
  constructor() { FakeCompilerWorker.instances.push(this) }
  postMessage(message: unknown) { this.message = message }
  terminate() { this.terminated = true }
}

async function withRunnerEnvironment(run: (frames: FakeFrame[]) => Promise<void>) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  const frames: FakeFrame[] = []
  FakeCompilerWorker.instances = []
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    baseURI: 'http://localhost:1420/',
    createElement: () => { const frame = new FakeFrame(); frames.push(frame); return frame },
  } })
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeCompilerWorker })
  try { await run(frames) }
  finally {
    for (const frame of frames) frame.remotePort?.close()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker)
    else Reflect.deleteProperty(globalThis, 'Worker')
  }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

test('browser execution returns its sandbox immediately and cancellation before setup allocates no worker', async () => {
  await withRunnerEnvironment(async (frames) => {
    const execution = createBrowserExecution({ code: '42', language: 'javascript', runId: 'cancel-before-setup' })
    assert.equal(execution.frame, frames[0] as unknown)
    assert.equal(frames[0].attributes.get('sandbox'), 'allow-scripts')
    assert.equal(frames[0].src, 'http://localhost:1420/browser-frame.html')
    execution.cancel()
    assert.deepEqual(await execution.completion, { success: false, output: [], error: 'Browser execution cancelled' })
    assert.equal(FakeCompilerWorker.instances.length, 0)
    assert.equal(frames[0].removed, true)
    assert.equal(frames[0].src, 'about:blank')
    execution.dispose()
  })
})

test('browser cancellation terminates compilation and ignores stale compiler replies', async () => {
  await withRunnerEnvironment(async (frames) => {
    const execution = createBrowserExecution({ code: '42', language: 'typescript', runId: 'cancel-compiler' })
    await Promise.resolve()
    const worker = FakeCompilerWorker.instances[0]
    assert.ok(worker)
    execution.cancel()
    worker.onmessage?.({ data: { success: true, code: 'late code' } })
    assert.equal((await execution.completion).success, false)
    assert.equal(worker.terminated, true)
    assert.equal(frames[0].received.length, 0)
  })
})

test('browser run streams output, snapshots completion, keeps preview alive and disposes later events', async () => {
  await withRunnerEnvironment(async (frames) => {
    const streamed: Output[] = []
    const execution = createBrowserExecution({ code: '42', language: 'javascript', runId: 'stream' }, (entry) => {
      streamed.push(entry)
      throw Error('closed subscriber')
    })
    try {
      await Promise.resolve()
      FakeCompilerWorker.instances[0].onmessage?.({ data: { success: true, code: 'compiled' } })
      frames[0].dispatchEvent(new Event('load'))
      for (let attempt = 0; !frames[0].received.length && attempt < 40; attempt++) await tick()
      assert.equal((frames[0].received[0] as { code: string }).code, 'compiled')
      const send = (message: unknown) => frames[0].remotePort!.postMessage(message)
      send({ kind: 'output', runId: 'wrong-run', output: { type: 'log', value: ['ignored'] } })
      send({ kind: 'output', runId: 'stream', output: { type: 'log', value: [{ unsafe: 'object handle' }] } })
      send({ kind: 'output', runId: 'stream', output: { type: 'result', value: ['42'], line: 1 } })
      send({ kind: 'complete', runId: 'stream', success: true })
      const response = await execution.completion
      assert.deepEqual(response, { success: true, output: [{ type: 'result', value: ['42'], line: 1 }] })
      assert.equal(frames[0].removed, false)
      send({ kind: 'output', runId: 'stream', output: { type: 'log', value: ['clicked'] } })
      await tick()
      assert.equal(streamed.length, 2)
      assert.equal(response.output.length, 1)
      execution.dispose()
      assert.equal(frames[0].removed, true)
    } finally { execution.dispose() }
  })
})

test('parent timeout resolves once, terminates its worker and removes an unresponsive frame', async () => {
  await withRunnerEnvironment(async (frames) => {
    const execution = createBrowserExecution({ code: 'await pending', language: 'javascript', runId: 'timeout', timeoutMs: 25 })
    const response = await execution.completion
    assert.equal(response.success, false)
    assert.match(response.error!, /timed out/)
    assert.equal(FakeCompilerWorker.instances[0].terminated, true)
    assert.equal(frames[0].removed, true)
    execution.cancel()
    assert.equal(await execution.completion, response)
  })
})

// Exercise the actual frame bootstrap in a separate JS realm. The import hook
// only substitutes the blob-module loader; compiler output and runtime code run.
function frameFixture() {
  const frameCode = ts.transpileModule(readFileSync('src/browser-frame.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const listeners = new Map<string, Set<(event: any) => void>>()
  const messages: Record<string, any>[] = []
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const blobs = new Map<string, { code: string }>()
  let nextId = 0
  let resolveCompletion!: (response: ExecuteResponse) => void
  const completion = new Promise<ExecuteResponse>((resolve) => { resolveCompletion = resolve })
  const context: Record<string, any> = {
    exports: {},
    parent: {},
    performance,
    console: {},
    Node: class {},
    Element: class {},
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++nextId
      timers.set(id, setTimeout(() => { timers.delete(id); callback() }, delay))
      return id
    },
    clearTimeout: (id: number) => { clearTimeout(timers.get(id)); timers.delete(id) },
    setInterval: (callback: () => void, delay = 0) => {
      const id = ++nextId
      timers.set(id, setInterval(callback, delay))
      return id
    },
    clearInterval: (id: number) => { clearInterval(timers.get(id)); timers.delete(id) },
    requestAnimationFrame: (callback: (time: number) => void) => context.setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: (id: number) => context.clearTimeout(id),
    addEventListener: (type: string, listener: (event: any) => void) => {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(listener)
    },
    removeEventListener: (type: string, listener: (event: any) => void) => listeners.get(type)?.delete(listener),
    document: { addEventListener() {} },
    Blob: class { code: string; constructor(parts: string[]) { this.code = parts.join('') } },
    URL: {
      createObjectURL: (blob: { code: string }) => { const url = `blob:test/${++nextId}`; blobs.set(url, blob); return url },
      revokeObjectURL: (url: string) => blobs.delete(url),
    },
  }
  context.window = context
  const realm = vm.createContext(context)
  context.Function = function (_argument: string, body: string) {
    assert.equal(body, 'return import(url)')
    return (url: string) => vm.runInContext(`(async () => { ${blobs.get(url)!.code}\n })()`, realm)
  }
  vm.runInContext(frameCode, realm)
  const port: Record<string, any> = {
    start() {},
    postMessage(message: Record<string, any>) {
      messages.push(message)
      if (message.kind === 'complete') resolveCompletion({
        success: message.success,
        output: messages.filter((entry) => entry.kind === 'output').map((entry) => entry.output),
        ...(message.error ? { error: message.error } : {}),
      })
    },
  }
  for (const listener of listeners.get('message') || []) listener({
    source: context.parent, data: { kind: 'jsblitz-connect', runId: 'fixture' }, ports: [port],
  })
  return {
    context, messages, completion,
    execute: (source: string, timeoutMs = 1000) => port.onmessage({ data: {
      kind: 'execute', runId: 'fixture', code: compile(source, 'typescript'), resultName, guardName, timeoutMs,
    } }),
    dispose: () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear() },
  }
}

test('frame captures safe string snapshots for circular/BigInt/Map/Error and never invokes getters or toJSON', async () => {
  const fixture = frameFixture()
  try {
    fixture.execute(`const value: any = { count: 2n }; value.self = value
console.log(value, new Map([['x', 1]]), new Error('visible'), {
  get forbidden() { throw new Error('getter must not run') },
  toJSON() { throw new Error('toJSON must not run') }
})`)
    const response = await fixture.completion
    assert.equal(response.success, true, response.error)
    const values = response.output.find((entry) => entry.type === 'log')!.value
    assert.match(values[0], /Circular/)
    assert.match(values[0], /2n/)
    assert.match(values[1], /Map\(1\)/)
    assert.match(values[2], /Error: visible/)
    assert.match(values[3], /forbidden: \[Getter\]/)
    assert.match(values[3], /toJSON: \[Function/)
    assert.ok(response.output.every((entry) => entry.value.every((value) => typeof value === 'string')))
  } finally { fixture.dispose() }
})

test('frame supports TLA, nested one-shot timers and resolved promise expression results', async () => {
  const fixture = frameFixture()
  try {
    fixture.execute(`await new Promise<void>(resolve => setTimeout(resolve, 5))
console.log('first')
setTimeout(() => { setTimeout(() => console.log('later'), 5) }, 5)
Promise.resolve(42)`)
    const response = await fixture.completion
    assert.equal(response.success, true, response.error)
    assert.deepEqual(response.output.filter((entry) => entry.type === 'log').map((entry) => [...entry.value]), [['first'], ['later']])
    assert.ok(response.output.some((entry) => entry.type === 'result' && entry.value[0] === '42' && entry.line === 4))
  } finally { fixture.dispose() }
})

test('frame captures asynchronous timer exceptions and stops a tight loop with its runtime guard', async () => {
  for (const [source, expected] of [
    ["console.log('before'); setTimeout(() => { throw Error('later error') }, 5)", /later error/],
    ["console.log('before'); while (true) {}", /synchronous time limit/],
  ] as const) {
    const fixture = frameFixture()
    try {
      fixture.execute(source, 25)
      const response = await fixture.completion
      assert.equal(response.success, false)
      assert.match(response.error!, expected)
      assert.equal(response.output[0].value[0], 'before')
    } finally { fixture.dispose() }
  }
})

test('frame does not keep completion pending for animation intervals and still streams their output afterward', async () => {
  const fixture = frameFixture()
  try {
    fixture.execute(`setInterval(() => console.log('animation tick'), 30); 'ready'`)
    const response = await fixture.completion
    assert.equal(response.success, true)
    assert.equal(response.output.at(-1)?.value[0], 'ready')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(fixture.messages.some((message) => message.output?.value[0] === 'animation tick'))
  } finally { fixture.dispose() }
})
