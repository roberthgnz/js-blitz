import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import ts from 'typescript'

import type { SecretStorage } from '../desktop/lib/settings'
import type { AssistantRequest, DesktopSettingsUpdate } from '../types/desktop'

const requireDependency = createRequire(
  path.join(process.cwd(), 'package.json')
)

// Load the real portable services with isolated settings state. No live
// credentials, desktop host, external network, or provider account is used.
function loadModule(filename: string, imports: Record<string, unknown> = {}) {
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

const loadSettings = () =>
  loadModule(
    'desktop/lib/settings.ts'
  ) as typeof import('../desktop/lib/settings')

async function harness(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'js-blitz-desktop-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const wrappingKey = randomBytes(32)
  const host = { available: true, locked: false }
  const settings = loadSettings()
  const portableStorage = settings.createSecretStorage(
    wrappingKey.toString('base64')
  )
  const storage: SecretStorage = {
    isAvailable: () => host.available,
    encryptString(value: string) {
      if (host.locked) throw new Error('Mock credential store locked')
      return portableStorage.encryptString(value)
    },
    decryptString(value: string) {
      if (host.locked) throw new Error('Mock credential store locked')
      return portableStorage.decryptString(value)
    },
  }
  const assistant = loadModule('desktop/lib/assistant.ts', {
    './settings': settings,
  }) as typeof import('../desktop/lib/assistant')
  const reload = loadSettings
  t.after(() => assistant.cancelAllAssistantRequests())
  await settings.configureSettings(directory, storage)
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
  return {
    settings,
    assistant,
    directory,
    host,
    storage,
    wrappingKey,
    update,
    reload,
  }
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

test('portable secret storage requires a canonical 32-byte key and authenticates randomized envelopes', () => {
  const { createSecretStorage } = loadSettings()
  const key = randomBytes(32).toString('base64')
  const storage = createSecretStorage(key)
  const sameKeyStorage = createSecretStorage(key)
  assert.equal(storage.isAvailable(), true)
  const credential = 'portable credential \u2713 \ud83d\udd10'
  const first = storage.encryptString(credential)
  const second = storage.encryptString(credential)
  assert.match(first, /^aes-256-gcm:v1:[A-Za-z0-9+/]+={0,2}$/)
  assert.notEqual(first, second)
  assert.equal(sameKeyStorage.decryptString(first), credential)
  assert.equal(storage.decryptString(second), credential)
  assert.equal(storage.decryptString(storage.encryptString('')), '')
  assert.throws(() =>
    createSecretStorage(randomBytes(32).toString('base64')).decryptString(first)
  )
  const unavailable = createSecretStorage()
  assert.equal(unavailable.isAvailable(), false)
  assert.throws(() => unavailable.encryptString(credential), /unavailable/)
  assert.throws(() => unavailable.decryptString(first), /unavailable/)
  for (const invalid of [
    '',
    key.trimEnd() + '\n',
    key.slice(0, -1),
    randomBytes(31).toString('base64'),
    randomBytes(33).toString('base64'),
    Buffer.alloc(32).toString('base64').slice(0, -2) + 'B=',
    Buffer.alloc(32, 255).toString('base64url'),
  ]) {
    assert.throws(
      () => createSecretStorage(invalid),
      /canonical base64.*32 bytes/
    )
  }
  for (const malformed of [
    'legacy-base64',
    first.replace(':v1:', ':v2:'),
    first + '\n',
    'aes-256-gcm:v1:',
    'aes-256-gcm:v1:' + Buffer.alloc(27).toString('base64'),
    'aes-256-gcm:v1:!!!!',
  ]) {
    assert.throws(() => storage.decryptString(malformed))
  }
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
  const { settings, directory, host, storage, update, reload } =
    await harness(t)
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
  assert.match(
    JSON.parse(storedText).assistant.encryptedApiKey,
    /^aes-256-gcm:v1:/
  )
  assert.equal(settings.getAssistantConfiguration().apiKey, credential)
  const reopened = reload()
  await reopened.initializeSettings(directory, storage)
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
  assert.throws(
    () => settings.getAssistantConfiguration(),
    /could not be unlocked/
  )
  const replaceWhileLocked = update()
  replaceWhileLocked.assistant.apiKey = randomBytes(20).toString('hex')
  assert.equal(
    (await settings.saveDesktopSettings(replaceWhileLocked)).success,
    false
  )
  assert.equal(await readFile(filename, 'utf8'), storedText)
  const remove = update()
  remove.assistant.clearApiKey = true
  assert.equal((await settings.saveDesktopSettings(remove)).success, true)
  assert.equal(settings.getDesktopSettings().assistant.hasApiKey, false)
  assert.equal(
    settings.getDesktopSettings().assistant.credentialError,
    undefined
  )
})

test('a wrong wrapping key retains credentials, blocks provider calls, and can be unlocked on the same path', async (t) => {
  const { settings, assistant, directory, storage, wrappingKey, update } =
    await harness(t)
  let calls = 0
  const endpoint = await provider(t, (_incoming, response) => {
    calls++
    response.end('{}')
  })
  const change = update()
  const credential = randomBytes(24).toString('hex')
  change.assistant.endpoint = endpoint
  change.assistant.apiKey = credential
  assert.equal((await settings.saveDesktopSettings(change)).success, true)
  const filename = path.join(directory, 'desktop-settings.json')
  const storedText = await readFile(filename, 'utf8')
  assert.equal(storedText.includes(wrappingKey.toString('base64')), false)
  await settings.configureSettings(
    directory,
    settings.createSecretStorage(randomBytes(32).toString('base64'))
  )
  const visible = settings.getDesktopSettings()
  assert.equal(visible.assistant.secureStorageAvailable, true)
  assert.equal(visible.assistant.hasApiKey, true)
  assert.match(
    visible.assistant.credentialError || '',
    /could not be unlocked.*Enter it again/
  )
  assert.equal(JSON.stringify(visible).includes(credential), false)
  assert.throws(
    () => settings.getAssistantConfiguration(),
    /could not be unlocked/
  )
  assert.equal((await assistant.askAssistant(request())).success, false)
  assert.equal(calls, 0)
  assert.equal(await readFile(filename, 'utf8'), storedText)
  await settings.configureSettings(directory, storage)
  assert.equal(settings.getAssistantConfiguration().apiKey, credential)
  assert.equal(
    settings.getDesktopSettings().assistant.credentialError,
    undefined
  )
})

test('tampering with an envelope IV, tag, or ciphertext never releases or removes the saved key', async (t) => {
  const { settings, directory, storage, update, reload } = await harness(t)
  const change = update()
  change.assistant.apiKey = randomBytes(24).toString('hex')
  assert.equal((await settings.saveDesktopSettings(change)).success, true)
  const filename = path.join(directory, 'desktop-settings.json')
  const original = JSON.parse(await readFile(filename, 'utf8'))
  const prefix = 'aes-256-gcm:v1:'
  const encoded = original.assistant.encryptedApiKey.slice(prefix.length)
  const tampered = [0, 12, 28].map((offset) => {
    const bytes = Buffer.from(encoded, 'base64')
    bytes[offset] ^= 1
    return prefix + bytes.toString('base64')
  })
  tampered.push(
    prefix + encoded + '\n',
    prefix + Buffer.alloc(27).toString('base64')
  )
  for (const encryptedApiKey of tampered) {
    const stored = {
      ...original,
      assistant: { ...original.assistant, encryptedApiKey },
    }
    await writeFile(filename, JSON.stringify(stored))
    const reopened = reload()
    await reopened.configureSettings(directory, storage)
    assert.equal(reopened.getDesktopSettings().assistant.hasApiKey, true)
    assert.match(
      reopened.getDesktopSettings().assistant.credentialError || '',
      /could not be unlocked/
    )
    assert.throws(
      () => reopened.getAssistantConfiguration(),
      /could not be unlocked/
    )
    assert.equal((await reopened.saveDesktopSettings(update())).success, true)
    assert.equal(
      JSON.parse(await readFile(filename, 'utf8')).assistant.encryptedApiKey,
      encryptedApiKey
    )
  }
})

test('missing or locked storage retains portable keys and unavailable errors fail closed', async (t) => {
  const { settings, directory, storage, host, update } = await harness(t)
  const change = update()
  change.assistant.apiKey = randomBytes(24).toString('hex')
  assert.equal((await settings.saveDesktopSettings(change)).success, true)
  const filename = path.join(directory, 'desktop-settings.json')
  const encryptedApiKey = JSON.parse(await readFile(filename, 'utf8')).assistant
    .encryptedApiKey
  await settings.configureSettings(directory)
  assert.equal(
    settings.getDesktopSettings().assistant.secureStorageAvailable,
    false
  )
  assert.equal(settings.getDesktopSettings().assistant.hasApiKey, true)
  assert.match(
    settings.getDesktopSettings().assistant.credentialError || '',
    /storage is unavailable/
  )
  assert.throws(
    () => settings.getAssistantConfiguration(),
    /storage is unavailable/
  )
  assert.equal((await settings.saveDesktopSettings(update())).success, true)
  assert.equal(
    JSON.parse(await readFile(filename, 'utf8')).assistant.encryptedApiKey,
    encryptedApiKey
  )
  await settings.configureSettings(directory, storage)
  host.available = false
  assert.throws(
    () => settings.getAssistantConfiguration(),
    /storage is unavailable/
  )
  await settings.configureSettings(directory, {
    ...storage,
    isAvailable: () => {
      throw new Error('Host credential store failure')
    },
  })
  assert.equal(
    settings.getDesktopSettings().assistant.secureStorageAvailable,
    false
  )
  assert.throws(
    () => settings.getAssistantConfiguration(),
    /storage is unavailable/
  )
})

test('legacy Electron credentials are retained with an explicit reentry error until replaced or removed', async (t) => {
  const { settings, directory, storage, update, reload } = await harness(t)
  assert.equal((await settings.saveDesktopSettings(update())).success, true)
  const filename = path.join(directory, 'desktop-settings.json')
  const stored = JSON.parse(await readFile(filename, 'utf8'))
  const legacy = randomBytes(48).toString('base64')
  stored.assistant.encryptedApiKey = legacy
  await writeFile(filename, JSON.stringify(stored))
  const reopened = reload()
  await reopened.configureSettings(directory, storage)
  assert.equal(reopened.getDesktopSettings().assistant.hasApiKey, true)
  assert.match(
    reopened.getDesktopSettings().assistant.credentialError || '',
    /old Electron.*cannot be unlocked.*Reenter/
  )
  assert.throws(
    () => reopened.getAssistantConfiguration(),
    /old Electron.*Reenter/
  )
  assert.equal((await reopened.saveDesktopSettings(update())).success, true)
  assert.equal(
    JSON.parse(await readFile(filename, 'utf8')).assistant.encryptedApiKey,
    legacy
  )
  const replacement = randomBytes(20).toString('hex')
  const replace = update()
  replace.assistant.apiKey = replacement
  assert.equal((await reopened.saveDesktopSettings(replace)).success, true)
  assert.equal(reopened.getAssistantConfiguration().apiKey, replacement)
  assert.equal(
    reopened.getDesktopSettings().assistant.credentialError,
    undefined
  )
  const portable = JSON.parse(await readFile(filename, 'utf8')).assistant
    .encryptedApiKey
  assert.match(portable, /^aes-256-gcm:v1:/)
  stored.assistant.encryptedApiKey = legacy
  await writeFile(filename, JSON.stringify(stored))
  const locked = reload()
  await locked.configureSettings(directory)
  assert.match(
    locked.getDesktopSettings().assistant.credentialError || '',
    /old Electron/
  )
  const remove = update()
  remove.assistant.clearApiKey = true
  assert.equal((await locked.saveDesktopSettings(remove)).success, true)
  assert.equal(locked.getDesktopSettings().assistant.hasApiKey, false)
  assert.equal(locked.getAssistantConfiguration().apiKey, undefined)
  assert.equal(
    'encryptedApiKey' in JSON.parse(await readFile(filename, 'utf8')).assistant,
    false
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

test('configuration and saves share a queue so changes persist to the configured path', async (t) => {
  const { settings, directory, update } = await harness(t)
  const nextDirectory = path.join(directory, 'next')
  const lastDirectory = path.join(directory, 'last')
  const lastStorage = settings.createSecretStorage(
    randomBytes(32).toString('base64')
  )
  const change = update({
    environment: [
      { id: 'queued', name: 'QUEUED_VALUE', value: 'last path', enabled: true },
    ],
  })
  const credential = randomBytes(20).toString('hex')
  change.assistant.apiKey = credential
  const firstConfiguration = settings.configureSettings(nextDirectory)
  const lastConfiguration = settings.configureSettings(
    lastDirectory,
    lastStorage
  )
  const save = settings.saveDesktopSettings(change)
  await Promise.all([firstConfiguration, lastConfiguration])
  assert.equal((await save).success, true)
  assert.equal(settings.getAssistantConfiguration().apiKey, credential)
  const stored = JSON.parse(
    await readFile(path.join(lastDirectory, 'desktop-settings.json'), 'utf8')
  )
  assert.deepEqual(stored.environment, change.environment)
  assert.equal(
    lastStorage.decryptString(stored.assistant.encryptedApiKey),
    credential
  )
  await assert.rejects(
    readFile(path.join(nextDirectory, 'desktop-settings.json')),
    { code: 'ENOENT' }
  )
  await assert.rejects(
    readFile(path.join(directory, 'desktop-settings.json')),
    { code: 'ENOENT' }
  )
})

test('failed configuration preserves the previous path, settings, and wrapping key without poisoning the queue', async (t) => {
  const { settings, directory, storage, update } = await harness(t)
  const change = update()
  const credential = randomBytes(20).toString('hex')
  change.assistant.apiKey = credential
  assert.equal((await settings.saveDesktopSettings(change)).success, true)
  const brokenDirectory = path.join(directory, 'broken')
  await mkdir(brokenDirectory)
  const brokenFile = path.join(brokenDirectory, 'desktop-settings.json')
  await writeFile(brokenFile, 'invalid JSON')
  await assert.rejects(
    settings.configureSettings(brokenDirectory),
    /could not be loaded/
  )
  assert.equal(settings.getAssistantConfiguration().apiKey, credential)
  assert.equal(
    settings.getDesktopSettings().assistant.secureStorageAvailable,
    true
  )
  assert.equal((await settings.saveDesktopSettings(update())).success, true)
  assert.equal(await readFile(brokenFile, 'utf8'), 'invalid JSON')
  const original = JSON.parse(
    await readFile(path.join(directory, 'desktop-settings.json'), 'utf8')
  )
  assert.equal(
    storage.decryptString(original.assistant.encryptedApiKey),
    credential
  )
  const recoveredDirectory = path.join(directory, 'recovered')
  await settings.configureSettings(recoveredDirectory)
  assert.equal((await settings.saveDesktopSettings(update())).success, true)
  assert.equal(
    settings.getDesktopSettings().assistant.secureStorageAvailable,
    false
  )
  assert.equal(settings.getDesktopSettings().assistant.hasApiKey, false)
})

test('failed disk writes preserve in-memory settings and unreadable settings are never overwritten', async (t) => {
  const { settings, directory, update } = await harness(t)
  const filename = path.join(directory, 'desktop-settings.json')
  await mkdir(filename)
  assert.equal((await settings.saveDesktopSettings(update())).success, false)
  assert.equal(settings.getDesktopSettings().assistant.model, '')
  await rm(filename, { recursive: true })
  await writeFile(filename, 'invalid JSON')
  const second = loadSettings()
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
