import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

import type {
  DesktopSettings,
  DesktopSettingsUpdate,
  EnvironmentVariable,
  SaveDesktopSettingsResponse,
} from '../../types/desktop'

interface StoredSettings {
  version: 1
  environment: EnvironmentVariable[]
  assistant: {
    endpoint: string
    model: string
    timeoutMs: number
    encryptedApiKey?: string
  }
}

let settingsFile: string | undefined
let settings: StoredSettings | undefined
let writes: Promise<unknown> = Promise.resolve()

class SettingsValidationError extends Error {}

const fail = (message: string): never => {
  throw new SettingsValidationError(message)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function validateEnvironment(value: unknown): EnvironmentVariable[] {
  if (!Array.isArray(value) || value.length > 200) {
    fail('Add up to 200 environment variables.')
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  return (value as unknown[]).map((entry, index) => {
    if (!isObject(entry)) fail('Each environment entry must be an object.')
    const item = entry as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
      ids.has(item.id)
    ) {
      fail(`Environment variable ${index + 1} needs a unique ID.`)
    }
    if (
      typeof item.name !== 'string' ||
      item.name.length > 256 ||
      !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(item.name)
    ) {
      fail(
        `Environment variable ${index + 1}: use letters, digits, and underscores, starting with a letter or underscore.`
      )
    }
    const name = item.name as string
    const comparison = process.platform === 'win32' ? name.toUpperCase() : name
    if (names.has(comparison))
      fail('Environment variable names must be unique.')
    if (
      typeof item.value !== 'string' ||
      item.value.length > 32768 ||
      item.value.includes('\0')
    ) {
      fail(
        `Environment variable ${index + 1} needs a value without null bytes (up to 32,768 characters).`
      )
    }
    if (typeof item.enabled !== 'boolean') {
      fail(`Environment variable ${index + 1} needs an enabled state.`)
    }
    ids.add(item.id as string)
    names.add(comparison)
    return {
      id: item.id as string,
      name,
      value: item.value as string,
      enabled: item.enabled as boolean,
    }
  })
}

function validateAssistant(value: unknown): StoredSettings['assistant'] {
  if (!isObject(value)) fail('Assistant settings are required.')
  const item = value as Record<string, unknown>
  if (typeof item.endpoint !== 'string' || item.endpoint.length > 2048) {
    fail('Enter an OpenAI-compatible HTTP or HTTPS base URL.')
  }
  let endpoint: URL
  try {
    endpoint = new URL((item.endpoint as string).trim())
  } catch {
    fail('Enter a valid OpenAI-compatible HTTP or HTTPS base URL.')
  }
  if (!['http:', 'https:'].includes(endpoint!.protocol)) {
    fail('The assistant endpoint must use HTTP or HTTPS.')
  }
  if (
    endpoint!.username ||
    endpoint!.password ||
    endpoint!.search ||
    endpoint!.hash
  ) {
    fail(
      'Use an endpoint without credentials, query parameters, or a fragment. Enter credentials in the API key field.'
    )
  }
  if (
    typeof item.model !== 'string' ||
    item.model.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(item.model)
  ) {
    fail('Enter a model ID with up to 200 characters.')
  }
  if (
    typeof item.timeoutMs !== 'number' ||
    !Number.isInteger(item.timeoutMs) ||
    item.timeoutMs < 1000 ||
    item.timeoutMs > 180000
  ) {
    fail('The assistant timeout must be between 1 and 180 seconds.')
  }
  return {
    endpoint: endpoint!.toString().replace(/\/+$/, ''),
    model: (item.model as string).trim(),
    timeoutMs: item.timeoutMs as number,
  }
}

function secureStorageAvailable(): boolean {
  try {
    // Linux basic_text uses a fixed password, so it is not a secret store.
    return (
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' ||
        safeStorage.getSelectedStorageBackend() !== 'basic_text')
    )
  } catch {
    return false
  }
}

function currentSettings(): StoredSettings {
  if (!settings || !settingsFile) {
    throw new Error(
      'Desktop settings are not ready. Restart the application and try again.'
    )
  }
  return settings
}

function decryptApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (!secureStorageAvailable()) {
    throw new Error(
      'The system credential store is unavailable. Unlock it or remove the saved API key to use a local provider.'
    )
  }
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    throw new Error(
      'The saved API key could not be unlocked. Enter it again in Assistant settings, or remove it to use a local provider.'
    )
  }
}

/** Call after app.whenReady(), before exposing settings or executing code. */
export async function initializeSettings(userDataPath: string): Promise<void> {
  await writes
  const nextFile = path.join(userDataPath, 'desktop-settings.json')
  if (settings && settingsFile === nextFile) return
  let next: StoredSettings
  try {
    const raw: unknown = JSON.parse(await fs.readFile(nextFile, 'utf8'))
    if (!isObject(raw) || raw.version !== 1 || !isObject(raw.assistant)) {
      throw new Error('Unsupported settings format.')
    }
    const assistant = validateAssistant(raw.assistant)
    const encryptedApiKey = raw.assistant.encryptedApiKey
    if (encryptedApiKey !== undefined) {
      if (
        typeof encryptedApiKey !== 'string' ||
        !encryptedApiKey.length ||
        encryptedApiKey.length > 65536 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedApiKey)
      ) {
        throw new Error('Invalid encrypted credential.')
      }
      assistant.encryptedApiKey = encryptedApiKey
    }
    next = {
      version: 1,
      environment: validateEnvironment(raw.environment),
      assistant,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Never overwrite an unreadable file with empty defaults.
      throw new Error(
        'Desktop settings could not be loaded. Check desktop-settings.json in the application data folder and restart.'
      )
    }
    next = {
      version: 1,
      environment: [],
      assistant: {
        endpoint: 'https://api.openai.com/v1',
        model: '',
        timeoutMs: 60000,
      },
    }
  }
  settingsFile = nextFile
  settings = next
}

/** Safe for IPC: contains status, never plaintext or encrypted API credentials. */
export function getDesktopSettings(): DesktopSettings {
  const current = currentSettings()
  let credentialError: string | undefined
  if (current.assistant.encryptedApiKey) {
    try {
      decryptApiKey(current.assistant.encryptedApiKey)
    } catch (error) {
      credentialError = (error as Error).message
    }
  }
  return {
    environment: current.environment.map((entry) => ({ ...entry })),
    assistant: {
      endpoint: current.assistant.endpoint,
      model: current.assistant.model,
      timeoutMs: current.assistant.timeoutMs,
      hasApiKey: !!current.assistant.encryptedApiKey,
      secureStorageAvailable: secureStorageAvailable(),
      ...(credentialError ? { credentialError } : {}),
    },
  }
}

async function persist(next: StoredSettings): Promise<void> {
  const filename = settingsFile!
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporaryFile = `${filename}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporaryFile, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await fs.rename(temporaryFile, filename)
  } catch (error) {
    await fs.unlink(temporaryFile).catch((): void => undefined)
    throw error
  }
}

/** Validate and atomically save; serialized to prevent overlapping disk writes. */
export function saveDesktopSettings(
  update: DesktopSettingsUpdate
): Promise<SaveDesktopSettingsResponse> {
  const operation = writes.then(
    async (): Promise<SaveDesktopSettingsResponse> => {
      try {
        const current = currentSettings()
        if (!isObject(update)) fail('Desktop settings are required.')
        const environment = validateEnvironment(update.environment)
        const assistant = validateAssistant(update.assistant)
        const { apiKey, clearApiKey } = update.assistant
        if (clearApiKey !== undefined && typeof clearApiKey !== 'boolean') {
          fail('Choose whether to remove the saved API key.')
        }
        if (
          apiKey !== undefined &&
          (typeof apiKey !== 'string' ||
            apiKey.length > 8192 ||
            /[\r\n\0]/.test(apiKey))
        ) {
          fail(
            'Enter a valid API key without line breaks (up to 8,192 characters).'
          )
        }
        if (clearApiKey && apiKey?.trim()) {
          fail(
            'Remove the saved API key or enter a replacement, rather than doing both.'
          )
        }
        if (
          current.assistant.encryptedApiKey &&
          !clearApiKey &&
          !apiKey?.trim() &&
          new URL(assistant.endpoint).origin !==
            new URL(current.assistant.endpoint).origin
        ) {
          fail(
            'When changing providers, enter a new API key or explicitly remove the saved key.'
          )
        }
        if (apiKey?.trim()) {
          if (!secureStorageAvailable()) {
            fail(
              'Secure credential storage is unavailable. Unlock your system credential store to save an API key. Local providers can be used without one.'
            )
          }
          try {
            assistant.encryptedApiKey = safeStorage
              .encryptString(apiKey.trim())
              .toString('base64')
          } catch {
            fail(
              'The API key could not be stored securely. Unlock your system credential store and try again.'
            )
          }
        } else if (!clearApiKey) {
          assistant.encryptedApiKey = current.assistant.encryptedApiKey
        }
        const next: StoredSettings = { version: 1, environment, assistant }
        await persist(next)
        settings = next
        return { success: true, settings: getDesktopSettings() }
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof SettingsValidationError
              ? error.message
              : 'Desktop settings could not be saved. Check the application data folder permissions and try again.',
        }
      }
    }
  )
  writes = operation.then(
    (): void => undefined,
    (): void => undefined
  )
  return operation
}

/** Enabled user overrides only. Merge into the execution process environment. */
export function getExecutionEnv(): Record<string, string> {
  const environment: Record<string, string> = Object.create(null)
  for (const entry of currentSettings().environment) {
    if (entry.enabled) environment[entry.name] = entry.value
  }
  return environment
}

/** Main-process use only. Do not expose this function over IPC. */
export function getAssistantConfiguration(): {
  endpoint: string
  model: string
  timeoutMs: number
  apiKey?: string
} {
  const current = currentSettings().assistant
  return {
    endpoint: current.endpoint,
    model: current.model,
    timeoutMs: current.timeoutMs,
    apiKey: decryptApiKey(current.encryptedApiKey),
  }
}
