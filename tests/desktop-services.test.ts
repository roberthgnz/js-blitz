import assert from 'node:assert/strict'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import ts from 'typescript'

import type { AssistantRequest, DesktopSettingsUpdate } from '../types/desktop'

const requireDependency = createRequire(
  path.join(process.cwd(), 'package.json')
)

// Load the real service modules, replacing only the Electron host. No live
// credentials, Electron process, external network, or provider account is used.
function loadModule(filename: string, imports: Record<string, unknown>) {
  const source = readFileSync(path.join(process.cwd(), filename), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  })
  const loaded = { exports: {} }
  const localRequire = (specifier: string) =>
    Object.prototype.hasOwnProperty.call(imports, specifier)
      ? imports[specifier]
      : requireDependency(specifier)
  new Function('require', 'module', 'exports', outputText)(
    localRequire,
    loaded,
    loaded.exports
  )
  return loaded.exports
}

async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'js-blitz-desktop-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const wrappingKey = randomBytes(32)
  const host = { available: true, locked: false }
  const safeStorage = {
    isEncryptionAvailable: () => host.available,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv)
      const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString(value: Buffer) {
      if (host.locked) throw new Error('Mock credential store locked')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        wrappingKey,
        value.subarray(0, 12)
      )
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([
        decipher.update(value.subarray(28)),
        decipher.final(),
      ]).toString('utf8')
    },
  }
  const settings = loadModule('electron/lib/settings.ts', {
    electron: { safeStorage },
  }) as typeof import('../electron/lib/settings')
  const assistant = loadModule('electron/lib/assistant.ts', {
    './settings': settings,
  }) as typeof import('../electron/lib/assistant')
  const reload = () =>
    loadModule('electron/lib/settings.ts', {
      electron: { safeStorage },
    }) as typeof import('../electron/lib/settings')
  t.after(() => assistant.cancelAllAssistantRequests())
  await settings.initializeSettings(directory)
  const update = (
    overrides: Partial<DesktopSettingsUpdate> = {}
  ): DesktopSettingsUpdate => ({
    environment: [],
    assistant: {
      endpoint: 'http://127.0.0.1:11434/v1',
      model: 'test-local-model',
      timeoutMs: 1000,
    },
    ...overrides,
  })
  return { settings, assistant, directory, host, update, reload }
}

async function provider(t: TestContext, handle: http.RequestListener) {
  const sockets = new Set<Socket>()
  const server = http.createServer(handle)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/v1`
}

const request = (id = randomUUID()): AssistantRequest => ({
  requestId: id,
  prompt: 'Explain this source and suggest a correction.',
  code: 'console.log(1 + 2)',
  history: [{ role: 'user', content: 'Help me understand this example.' }],
})

test('environment CRUD persists, validates, and exposes only enabled overrides', async (t) => {
  const { settings, directory, update, reload } = await harness(t)
  const environment = [
    { id: 'one', name: 'EXAMPLE_VALUE', value: 'hello', enabled: true },
    { id: 'two', name: 'DISABLED_VALUE', value: 'hidden', enabled: false },
  ]
  assert.equal(
    (await settings.saveDesktopSettings(update({ environment }))).success,
    true
  )
  assert.deepEqual(
    { ...settings.getExecutionEnv() },
    { EXAMPLE_VALUE: 'hello' }
  )
  const detached = settings.getDesktopSettings()
  detached.environment[0].value = 'renderer mutation'
  assert.equal(settings.getDesktopSettings().environment[0].value, 'hello')
  const stored = JSON.parse(
    await readFile(path.join(directory, 'desktop-settings.json'), 'utf8')
  )
  assert.deepEqual(stored.environment, environment)
  const reopened = reload()
  await reopened.initializeSettings(directory)
  assert.deepEqual(reopened.getDesktopSettings().environment, environment)
  for (const invalid of [
    [{ ...environment[0], name: 'BAD-NAME' }],
    [{ ...environment[0], value: 'null\0byte' }],
    [environment[0], { ...environment[1], name: 'EXAMPLE_VALUE' }],
  ]) {
    assert.equal(
      (await settings.saveDesktopSettings(update({ environment: invalid })))
        .success,
      false
    )
    assert.deepEqual(settings.getDesktopSettings().environment, environment)
  }
  assert.equal(
    (
      await settings.saveDesktopSettings(
        update({ environment: [environment[1]] })
      )
    ).success,
    true
  )
  assert.deepEqual({ ...settings.getExecutionEnv() }, {})
  assert.equal(settings.getDesktopSettings().environment.length, 1)
})

test('credentials are encrypted at rest, write-only over IPC, retained, and explicitly removable', async (t) => {
  const { settings, directory, host, update, reload } = await harness(t)
  const credential = randomBytes(32).toString('hex')
  const change = update()
  change.assistant.apiKey = credential
  const saved = await settings.saveDesktopSettings(change)
  assert.equal(saved.success, true)
  assert.equal(settings.getDesktopSettings().assistant.hasApiKey, true)
  assert.equal(JSON.stringify(saved).includes(credential), false)
  assert.equal(
    JSON.stringify(settings.getDesktopSettings()).includes('encryptedApiKey'),
    false
  )
  const filename = path.join(directory, 'desktop-settings.json')
  const storedText = await readFile(filename, 'utf8')
  assert.equal(storedText.includes(credential), false)
  assert.equal(
    typeof JSON.parse(storedText).assistant.encryptedApiKey,
    'string'
  )
  assert.equal(settings.getAssistantConfiguration().apiKey, credential)
  const reopened = reload()
  await reopened.initializeSettings(directory)
  assert.equal(reopened.getAssistantConfiguration().apiKey, credential)
  assert.equal((await settings.saveDesktopSettings(update())).success, true)
  assert.equal(settings.getAssistantConfiguration().apiKey, credential)
  const otherProvider = update()
  otherProvider.assistant.endpoint = 'http://localhost:1234/v1'
  assert.equal(
    (await settings.saveDesktopSettings(otherProvider)).success,
    false
  )
  host.locked = true
  assert.match(
    settings.getDesktopSettings().assistant.credentialError || '',
    /unlocked/
  )
  assert.equal(settings.getDesktopSettings().assistant.hasApiKey, true)
  const remove = update()
  remove.assistant.clearApiKey = true
  assert.equal((await settings.saveDesktopSettings(remove)).success, true)
  assert.equal(settings.getDesktopSettings().assistant.hasApiKey, false)
  assert.equal(
    settings.getDesktopSettings().assistant.credentialError,
    undefined
  )
})

test('unavailable secret storage rejects key persistence but permits local no-key settings', async (t) => {
  const { settings, directory, host, update } = await harness(t)
  host.available = false
  const change = update()
  change.assistant.apiKey = randomBytes(20).toString('hex')
  const saved = await settings.saveDesktopSettings(change)
  assert.equal(saved.success, false)
  if (saved.success === false)
    assert.match(saved.error, /Secure credential storage/)
  assert.equal((await settings.saveDesktopSettings(update())).success, true)
  assert.equal(
    settings.getDesktopSettings().assistant.secureStorageAvailable,
    false
  )
  assert.equal(
    (
      await readFile(path.join(directory, 'desktop-settings.json'), 'utf8')
    ).includes('encryptedApiKey'),
    false
  )
})

test('failed disk writes preserve in-memory settings and unreadable settings are never overwritten', async (t) => {
  const { settings, directory, update } = await harness(t)
  const filename = path.join(directory, 'desktop-settings.json')
  await mkdir(filename)
  assert.equal((await settings.saveDesktopSettings(update())).success, false)
  assert.equal(settings.getDesktopSettings().assistant.model, '')
  await rm(filename, { recursive: true })
  await writeFile(filename, 'invalid JSON')
  const second = loadModule('electron/lib/settings.ts', {
    electron: { safeStorage: {} },
  }) as typeof import('../electron/lib/settings')
  await assert.rejects(
    second.initializeSettings(directory),
    /could not be loaded/
  )
  assert.equal(await readFile(filename, 'utf8'), 'invalid JSON')
})

test('assistant sends a real compatible HTTP request with source/history and extracts code', async (t) => {
  const { settings, assistant, update } = await harness(t)
  let received: {
    path?: string
    auth?: string
    body?: Record<string, unknown>
  } = {}
  const endpoint = await provider(t, (incoming, response) => {
    let body = ''
    incoming.on('data', (chunk) => {
      body += String(chunk)
    })
    incoming.on('end', () => {
      received = {
        path: incoming.url,
        auth: incoming.headers.authorization,
        body: JSON.parse(body),
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Try this:\n```typescript\nconsole.log(3)\n```',
              },
            },
          ],
        })
      )
    })
  })
  const change = update()
  change.assistant.endpoint = endpoint
  assert.equal((await settings.saveDesktopSettings(change)).success, true)
  const result = await assistant.askAssistant(request(), 'window-one')
  assert.equal(result.success, true)
  if (result.success)
    assert.deepEqual(result.codeBlocks, [
      { language: 'typescript', code: 'console.log(3)' },
    ])
  assert.equal(received.path, '/v1/chat/completions')
  assert.equal(received.auth, undefined)
  assert.equal(received.body?.model, 'test-local-model')
  assert.equal(received.body?.stream, false)
  assert.match(
    JSON.stringify(received.body?.messages),
    /console\.log\(1 \+ 2\)/
  )
  assert.match(JSON.stringify(received.body?.messages), /Help me understand/)
  assert.deepEqual(
    assistant.extractAssistantCodeBlocks(
      '~~~~js\nconst a = `x`\n~~~~\n\n```js\nsecond()\n```'
    ),
    [
      { language: 'js', code: 'const a = `x`' },
      { language: 'js', code: 'second()' },
    ]
  )
})

test('assistant timeout and cancellation stop HTTP work and cancellation is scoped to its window', async (t) => {
  const { settings, assistant, update } = await harness(t)
  let onIncoming: (() => void) | undefined
  const endpoint = await provider(t, () => onIncoming?.())
  const change = update()
  change.assistant.endpoint = endpoint
  await settings.saveDesktopSettings(change)
  const timedOut = await assistant.askAssistant(request(), 'one')
  assert.equal(timedOut.success, false)
  if (timedOut.success === false) assert.equal(timedOut.errorCode, 'timeout')
  const incoming = new Promise<void>((resolve) => {
    onIncoming = resolve
  })
  const cancellable = request()
  const pending = assistant.askAssistant(cancellable, 'one')
  await incoming
  assert.equal(
    assistant.cancelAssistant(cancellable.requestId, 'other-window'),
    false
  )
  assert.equal(assistant.cancelAssistant(cancellable.requestId, 'one'), true)
  const cancelled = await pending
  assert.equal(cancelled.success, false)
  if (cancelled.success === false)
    assert.equal(cancelled.errorCode, 'cancelled')
  assert.equal(assistant.cancelAssistant(cancellable.requestId, 'one'), false)
})

test('provider failures are friendly and never echo error bodies; redirects are not followed', async (t) => {
  const { settings, assistant, update } = await harness(t)
  let status = 401
  let calls = 0
  const marker = randomUUID()
  const endpoint = await provider(t, (_incoming, response) => {
    calls++
    response.writeHead(status, { Location: '/must-not-follow' })
    response.end(JSON.stringify({ error: { message: marker } }))
  })
  const change = update()
  change.assistant.endpoint = endpoint
  await settings.saveDesktopSettings(change)
  for (const nextStatus of [401, 404, 429, 503, 302]) {
    status = nextStatus
    const result = await assistant.askAssistant(request())
    assert.equal(result.success, false)
    assert.equal(JSON.stringify(result).includes(marker), false)
    if (result.success === false) assert.equal(result.errorCode, 'provider')
  }
  assert.equal(calls, 5)
})

test('assistant rejects malformed/oversized responses and redacts an echoed credential', async (t) => {
  const { settings, assistant, update } = await harness(t)
  let responseBody = 'not JSON'
  let receivedAuthorization: string | undefined
  const endpoint = await provider(t, (incoming, response) => {
    receivedAuthorization = incoming.headers.authorization
    response.end(responseBody)
  })
  const credential = randomBytes(24).toString('hex')
  const change = update()
  change.assistant.endpoint = endpoint
  change.assistant.apiKey = credential
  await settings.saveDesktopSettings(change)
  for (const body of [
    'not JSON',
    JSON.stringify({ choices: [] }),
    'x'.repeat(2 * 1024 * 1024 + 1),
  ]) {
    responseBody = body
    const result = await assistant.askAssistant(request())
    assert.equal(result.success, false)
    if (result.success === false)
      assert.equal(result.errorCode, 'invalid-response')
  }
  responseBody = JSON.stringify({
    choices: [{ message: { content: `Answer ${credential}` } }],
  })
  const result = await assistant.askAssistant(request())
  assert.equal(result.success, true)
  assert.equal(receivedAuthorization, `Bearer ${credential}`)
  assert.equal(JSON.stringify(result).includes(credential), false)
})
