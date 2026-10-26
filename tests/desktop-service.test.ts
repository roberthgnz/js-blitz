import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'

interface Message {
  id?: string
  result?: any
  error?: string
  event?: string
  args?: any[]
}

async function service(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jsblitz-service-test-'))
  const servicePath =
    process.env.JSBLITZ_SERVICE_PATH ||
    process.env.JSBLITZ_TEST_SERVICE ||
    path.resolve('desktop/service.ts')
  const loader = pathToFileURL(createRequire(__filename).resolve('tsx')).href
  const child = spawn(
    process.execPath,
    [...(servicePath.endsWith('.ts') ? ['--import', loader] : []), servicePath],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        JSBLITZ_WORKER_PATH:
          process.env.JSBLITZ_TEST_WORKER ||
          process.env.JSBLITZ_WORKER_PATH ||
          path.resolve('desktop/lib/execution-worker.ts'),
      },
    }
  )
  const messages: Message[] = []
  const noise: string[] = []
  const events = new EventEmitter()
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as Message
      messages.push(message)
      events.emit('message', message)
    } catch {
      noise.push(line)
    }
  })
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      events.emit('exit')
      resolve(code)
    })
  )
  const waitFor = (
    predicate: (message: Message) => boolean
  ): Promise<Message> => {
    const previous = messages.find(predicate)
    if (previous) return Promise.resolve(previous)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        events.off('message', listener)
        events.off('exit', onExit)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Service response timed out. stderr: ${stderr}`))
      }, 15000)
      const onExit = () => {
        cleanup()
        reject(new Error(`Service exited before replying. stderr: ${stderr}`))
      }
      const listener = (message: Message) => {
        if (predicate(message)) {
          cleanup()
          resolve(message)
        }
      }
      events.on('message', listener)
      events.once('exit', onExit)
    })
  }
  const request = (method: string, params: unknown = null) => {
    const id = randomUUID()
    const response = waitFor((message) => message.id === id)
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    return response
  }
  const userDataPath = path.join(directory, 'datos_ñ')
  const workspacePath = path.join(directory, 'workspace')
  const initialize = (credentialKey?: string) =>
    request('initialize', { userDataPath, workspacePath, credentialKey })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
    lines.close()
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    })
    assert.deepEqual(
      noise,
      [],
      'stdout must contain JSON protocol messages only'
    )
  })
  return {
    child,
    directory,
    userDataPath,
    workspacePath,
    messages,
    request,
    waitFor,
    initialize,
    exited,
  }
}

const settingsUpdate = (
  endpoint = 'http://127.0.0.1:1/v1',
  apiKey?: string
) => ({
  environment: [
    {
      id: 'enabled',
      name: 'JSBLITZ_SERVICE_ENV',
      value: 'from-settings',
      enabled: true,
    },
    {
      id: 'disabled',
      name: 'JSBLITZ_DISABLED_ENV',
      value: 'hidden',
      enabled: false,
    },
  ],
  assistant: {
    endpoint,
    model: 'local-test',
    timeoutMs: 1000,
    ...(apiKey ? { apiKey } : {}),
  },
})

test(
  'service validates initialization, direct params and bounded split JSON lines',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    assert.match(
      (await host.request('getDesktopSettings')).error!,
      /Initialize/
    )
    const invalidKey = await host.request('initialize', {
      userDataPath: host.userDataPath,
      workspacePath: host.workspacePath,
      credentialKey: 'do-not-echo-this-key',
    })
    assert.match(invalidKey.error!, /wrapping key/)
    assert.doesNotMatch(JSON.stringify(invalidKey), /do-not-echo/)
    host.child.stdin.write('{"credentialKey":"never-echo-malformed-secret",}\n')
    const malformed = await host.waitFor(
      (message) => message.error === 'Invalid JSON request.'
    )
    assert.equal(malformed.id, '')
    assert.doesNotMatch(JSON.stringify(malformed), /never-echo/)

    const id = randomUUID()
    const data = Buffer.from(
      JSON.stringify({
        id,
        method: 'initialize',
        params: {
          userDataPath: host.userDataPath,
          workspacePath: host.workspacePath,
        },
      }) + '\n'
    )
    const split = data.indexOf(Buffer.from('ñ')) + 1
    host.child.stdin.write(data.subarray(0, split))
    await new Promise((resolve) => setTimeout(resolve, 20))
    host.child.stdin.write(data.subarray(split))
    assert.equal(
      (await host.waitFor((message) => message.id === id)).result,
      null
    )
    assert.match(
      (
        await host.request('initialize', {
          userDataPath: host.userDataPath,
          workspacePath: host.workspacePath,
        })
      ).error!,
      /already initialized/
    )
    assert.match(
      (await host.request('getDesktopSettings', [])).error!,
      /parameters/
    )
    assert.equal(
      (await host.request('getDesktopSettings')).result.assistant
        .secureStorageAvailable,
      false
    )
    assert.match((await host.request('unknown', null)).error!, /Unknown/)
    assert.match(
      (await host.request('installPackage', '../escape')).error!,
      /registry package/
    )

    host.child.stdin.write(Buffer.alloc(8 * 1024 * 1024 + 1, 120))
    host.child.stdin.write('\n')
    await host.waitFor((message) => !!message.error?.includes('size limit'))
    assert.deepEqual((await host.request('listPackages')).result, [])
    assert.equal((await host.request('shutdown')).result, null)
    assert.equal(await host.exited, 0)
  }
)

test(
  'service streams TypeScript, raw worker stdout and statuses while applying settings env',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    assert.equal((await host.initialize()).result, null)
    assert.equal(
      (await host.request('saveDesktopSettings', settingsUpdate())).result
        .success,
      true
    )
    const runId = randomUUID()
    const response = await host.request('executeCode', {
      runId,
      language: 'typescript',
      code: `const answer: number = 42
console.log(process.env.JSBLITZ_SERVICE_ENV, process.env.JSBLITZ_DISABLED_ENV)
process.stdout.write('raw worker output\\n'); void 0
setTimeout(() => console.log('later'), 30); void 0
answer`,
      env: { JSBLITZ_SERVICE_ENV: 'must-not-override-settings' },
    })
    assert.equal(response.result.success, true, response.result.error)
    assert.ok(
      response.result.output.some(
        (entry: any) => entry.type === 'result' && entry.value[0] === '42'
      )
    )
    assert.ok(
      response.result.output.some(
        (entry: any) =>
          entry.value[0] === 'from-settings' && entry.value[1] === 'undefined'
      )
    )
    assert.ok(
      response.result.output.some(
        (entry: any) => entry.value[0] === 'raw worker output'
      )
    )
    const notifications = host.messages.filter(
      (message) => message.event === 'execution-output'
    )
    assert.deepEqual(
      notifications.map((message) => message.args?.[0]?.output),
      response.result.output
    )
    assert.ok(
      notifications.every((message) => message.args?.[0]?.runId === runId)
    )
    assert.deepEqual(
      host.messages.filter((message) =>
        message.event?.startsWith('code-execution-')
      ),
      [
        { event: 'code-execution-started', args: [] },
        { event: 'code-execution-finished', args: [] },
      ]
    )
  }
)

test(
  'service handles cancellation concurrently and can execute again',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    await host.initialize()
    const runId = randomUUID()
    const pending = host.request('executeCode', {
      runId,
      code: `console.log('ready'); while (true) {}`,
    })
    await host.waitFor(
      (message) =>
        message.event === 'execution-output' &&
        message.args?.[0]?.runId === runId
    )
    assert.equal((await host.request('cancelExecution', runId)).result, null)
    const response = await pending
    assert.equal(response.result.success, false)
    assert.match(response.result.error, /cancelled/)
    assert.equal(
      (await host.request('executeCode', { runId, code: '21 * 2' })).result
        .success,
      true
    )
  }
)

test(
  'service retains package manifest and lists cached packages and definitions without network',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    const packagePath = path.join(
      host.workspacePath,
      'node_modules',
      'service-test-fixture'
    )
    await mkdir(packagePath, { recursive: true })
    await writeFile(
      path.join(packagePath, 'package.json'),
      JSON.stringify({ name: 'service-test-fixture', version: '1.0.0' })
    )
    await writeFile(
      path.join(packagePath, 'index.d.ts'),
      'export declare const answer: 42'
    )
    await writeFile(
      path.join(host.workspacePath, 'package.json'),
      JSON.stringify({
        name: 'existing-workspace',
        private: true,
        custom: 'preserved',
        dependencies: { 'service-test-fixture': '1.0.0' },
      })
    )
    await host.initialize()
    assert.deepEqual((await host.request('listPackages')).result, [
      { name: 'service-test-fixture', version: '1.0.0' },
    ])
    assert.equal(
      (await host.request('installPackage', 'service-test-fixture@1.0.0'))
        .result,
      null
    )
    const definitions = (await host.request('getTypeDefinitions')).result
    assert.ok(
      definitions.some(
        (entry: any) =>
          entry.path ===
          'file:///workspace/node_modules/service-test-fixture/index.d.ts'
      )
    )
    assert.equal(
      JSON.parse(
        await readFile(path.join(host.workspacePath, 'package.json'), 'utf8')
      ).custom,
      'preserved'
    )
  }
)

test(
  'service persists credentials only with stdin key and never exposes them to workers',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    const key = randomBytes(32).toString('base64')
    const apiKey = 'synthetic-service-provider-key'
    await host.initialize(key)
    const saved = (
      await host.request(
        'saveDesktopSettings',
        settingsUpdate(undefined, apiKey)
      )
    ).result
    assert.equal(saved.success, true)
    assert.equal(saved.settings.assistant.hasApiKey, true)
    const persisted = await readFile(
      path.join(host.userDataPath, 'desktop-settings.json'),
      'utf8'
    )
    assert.doesNotMatch(persisted, /synthetic-service-provider-key/)
    assert.match(
      JSON.parse(persisted).assistant.encryptedApiKey,
      /^aes-256-gcm:v1:/
    )
    const executed = await host.request('executeCode', {
      runId: randomUUID(),
      code: `console.log(JSON.stringify(process.env), JSON.stringify(process.argv))`,
    })
    assert.equal(executed.result.success, true, executed.result.error)
    assert.ok(!JSON.stringify(host.messages).includes(key))
    assert.ok(!JSON.stringify(host.messages).includes(apiKey))
  }
)

test(
  'unavailable credential storage allows local AI and concurrent cancellation',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    let requests = 0
    const server = createServer((request, response) => {
      requests++
      request.resume()
      if (requests === 1) {
        response.setHeader('content-type', 'application/json')
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'local answer' } }],
          })
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const endpoint = `http://127.0.0.1:${address.port}/v1`
    await host.initialize()
    const refused = (
      await host.request(
        'saveDesktopSettings',
        settingsUpdate(endpoint, 'must-not-persist')
      )
    ).result
    assert.equal(refused.success, false)
    assert.match(refused.error, /unavailable|secure/i)
    assert.equal(
      (await host.request('saveDesktopSettings', settingsUpdate(endpoint)))
        .result.success,
      true
    )
    const answer = (
      await host.request('askAssistant', {
        requestId: 'local',
        prompt: 'hello',
        code: '',
      })
    ).result
    assert.equal(answer.success, true, answer.error)
    assert.equal(answer.content, 'local answer')
    const waiting = host.request('askAssistant', {
      requestId: 'cancel_me',
      prompt: 'wait',
      code: '',
    })
    // A cancellation request in the same pipe must be dispatched while AI awaits I/O.
    const cancelled = await host.request('cancelAssistant', 'cancel_me')
    assert.equal(cancelled.result, true)
    assert.equal((await waiting).result.errorCode, 'cancelled')
  }
)

for (const reason of ['shutdown', 'stdin-close'] as const) {
  test(
    `${reason} terminates active workers and prevents later filesystem mutation`,
    { timeout: 30000 },
    async (t) => {
      const host = await service(t)
      await host.initialize()
      const marker = path.join(host.workspacePath, 'must-not-exist')
      const runId = randomUUID()
      const pending = host.request('executeCode', {
        runId,
        code: `console.log('ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 700); void 0`,
      })
      await host.waitFor(
        (message) =>
          message.event === 'execution-output' &&
          message.args?.[0]?.runId === runId
      )
      if (reason === 'shutdown') {
        assert.equal((await host.request('shutdown')).result, null)
        assert.equal((await pending).result.success, false)
      } else {
        // No reply is possible once the native host closes its input channel.
        void pending.catch(() => {})
        host.child.stdin.end()
      }
      assert.equal(await host.exited, 0)
      await new Promise((resolve) => setTimeout(resolve, 900))
      assert.equal(existsSync(marker), false)
    }
  )
}

test(
  'shutdown rejects work queued in the same input chunk and flushes its reply',
  { timeout: 30000 },
  async (t) => {
    const host = await service(t)
    await host.initialize()
    const shutdown = randomUUID()
    const execute = randomUUID()
    host.child.stdin.write(
      [
        JSON.stringify({ id: shutdown, method: 'shutdown', params: null }),
        JSON.stringify({
          id: execute,
          method: 'executeCode',
          params: { runId: randomUUID(), code: 'while (true) {}' },
        }),
        '',
      ].join('\n')
    )
    assert.match(
      (await host.waitFor((message) => message.id === execute)).error!,
      /shutting down/
    )
    assert.equal(
      (await host.waitFor((message) => message.id === shutdown)).result,
      null
    )
    assert.equal(await host.exited, 0)
  }
)
