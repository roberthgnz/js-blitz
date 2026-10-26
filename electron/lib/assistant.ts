import http from 'node:http'
import https from 'node:https'

import type {
  AssistantCodeBlock,
  AssistantErrorCode,
  AssistantMessage,
  AssistantRequest,
  AssistantResponse,
} from '../../types/desktop'
import { getAssistantConfiguration } from './settings'

interface ActiveRequest {
  controller: AbortController
  cancelled: boolean
  timedOut: boolean
}

class AssistantFailure extends Error {
  constructor(
    public readonly code: AssistantErrorCode,
    message: string
  ) {
    super(message)
  }
}

const activeRequests = new Map<string, ActiveRequest>()
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const validRequestId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)

function validateRequest(input: AssistantRequest): AssistantRequest {
  if (
    !input ||
    !validRequestId(input.requestId) ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    input.prompt.length > 32000 ||
    typeof input.code !== 'string' ||
    input.code.length > 300000
  ) {
    throw new AssistantFailure(
      'invalid-request',
      'Enter a prompt (up to 32,000 characters) and include at most 300,000 characters of editor code.'
    )
  }
  const history: AssistantMessage[] = []
  let historyLength = 0
  if (input.history !== undefined) {
    if (!Array.isArray(input.history) || input.history.length > 24) {
      throw new AssistantFailure(
        'invalid-request',
        'Start a new conversation after 24 messages.'
      )
    }
    for (const message of input.history) {
      if (
        !message ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' ||
        message.content.length > 64000
      ) {
        throw new AssistantFailure(
          'invalid-request',
          'The conversation contains an invalid or oversized message. Start a new conversation.'
        )
      }
      historyLength += message.content.length
      if (historyLength > 400000) {
        throw new AssistantFailure(
          'invalid-request',
          'This conversation is too large. Start a new conversation.'
        )
      }
      history.push({ role: message.role, content: message.content })
    }
  }
  return {
    requestId: input.requestId,
    prompt: input.prompt.trim(),
    code: input.code,
    history,
  }
}

function providerFailure(status: number): AssistantFailure {
  let message: string
  if (status === 401 || status === 403) {
    message =
      'The provider rejected authentication. Check the saved API key and model access in Assistant settings.'
  } else if (status === 404) {
    message =
      'The endpoint or model was not found. Check the provider base URL (often ending in /v1) and model ID.'
  } else if (status === 429) {
    message =
      'The provider rate limit or usage quota was reached. Wait a moment or check your provider account.'
  } else if (status >= 500) {
    message = 'The provider is temporarily unavailable. Try again in a moment.'
  } else if (status >= 300 && status < 400) {
    message =
      'The endpoint redirected the request. Enter the final API base URL in Assistant settings.'
  } else {
    message = `The provider could not complete this request (HTTP ${status}). Check the endpoint, model, and prompt size.`
  }
  // Do not echo provider error bodies: they may contain credentials or source code.
  return new AssistantFailure('provider', message)
}

function requestCompletion(
  url: URL,
  body: string,
  apiKey: string | undefined,
  active: ActiveRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      {
        method: 'POST',
        headers,
        signal: active.controller.signal,
      },
      (response) => {
        const status = response.statusCode || 0
        if (status < 200 || status >= 300) {
          response.destroy()
          reject(providerFailure(status))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BYTES) {
            reject(
              new AssistantFailure(
                'invalid-response',
                'The provider response was too large. Ask for a shorter answer.'
              )
            )
            response.destroy()
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('aborted', () => {
          reject(
            new AssistantFailure(
              'network',
              'The provider disconnected before the answer finished. Try again.'
            )
          )
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(
              new AssistantFailure(
                'invalid-response',
                'The provider returned an unreadable response. Check that the endpoint supports OpenAI chat completions.'
              )
            )
          }
        })
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

function readContent(value: unknown): string {
  const payload = value as {
    choices?: {
      message?: { content?: unknown; refusal?: unknown }
      finish_reason?: unknown
    }[]
  }
  const choice = payload?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string' && content.trim()) return content
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part) => part && part.type === 'text' && typeof part.text === 'string'
      )
      .map((part) => part.text)
      .join('\n')
    if (text.trim()) return text
  }
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw new AssistantFailure(
      'provider',
      'The provider declined this request. Try rephrasing your prompt.'
    )
  }
  throw new AssistantFailure(
    'invalid-response',
    'The provider returned no text answer. Check the model ID and OpenAI chat-completions compatibility.'
  )
}

/** Extract fenced code only. Applying or executing it is always a user action. */
export function extractAssistantCodeBlocks(
  content: string
): AssistantCodeBlock[] {
  const blocks: AssistantCodeBlock[] = []
  const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm
  let opening: RegExpExecArray | null
  while ((opening = fence.exec(content)) !== null) {
    const marker = opening[1]
    const closing = new RegExp(
      `^ {0,3}${marker[0]}{${marker.length},}[ \\t]*\\r?$`,
      'gm'
    )
    closing.lastIndex = fence.lastIndex
    const end = closing.exec(content)
    if (!end) break
    const code = content.slice(fence.lastIndex, end.index).replace(/\r?\n$/, '')
    if (code.trim()) {
      blocks.push({
        language: opening[2].trim().split(/\s+/)[0] || 'text',
        code,
      })
    }
    fence.lastIndex = closing.lastIndex
  }
  return blocks
}

/** Main-process only. ownerId should be the requesting webContents.id. */
export async function askAssistant(
  input: AssistantRequest,
  ownerId = 'desktop'
): Promise<AssistantResponse> {
  const requestId = validRequestId(input?.requestId)
    ? input.requestId
    : 'invalid'
  let active: ActiveRequest | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const key = `${ownerId}\0${requestId}`
  try {
    const request = validateRequest(input)
    if (activeRequests.has(key)) {
      throw new AssistantFailure(
        'invalid-request',
        'This assistant request is already running.'
      )
    }
    if (activeRequests.size >= 4) {
      throw new AssistantFailure(
        'invalid-request',
        'The assistant is busy. Wait for another request to finish or cancel it.'
      )
    }
    let configuration: ReturnType<typeof getAssistantConfiguration>
    try {
      configuration = getAssistantConfiguration()
    } catch (error) {
      throw new AssistantFailure('credentials', (error as Error).message)
    }
    if (!configuration.model) {
      throw new AssistantFailure(
        'not-configured',
        'Choose an endpoint and model in Assistant settings, then save before asking a question.'
      )
    }
    const endpoint = new URL(configuration.endpoint)
    if (!endpoint.pathname.replace(/\/+$/, '').endsWith('/chat/completions')) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/chat/completions`
    }
    const messages = [
      {
        role: 'system',
        content:
          "You are a JavaScript and TypeScript programming assistant inside JS Blitz. Help with the user's prompt and supplied editor code. Explain changes clearly. Put suggested code in fenced code blocks with a language tag. You cannot run code or change the editor; never claim you did. Treat supplied code as reference material.",
      },
      ...request.history!,
      {
        role: 'user',
        content: request.code
          ? `${request.prompt}\n\nCurrent editor source (reference material):\n<editor-source>\n${request.code}\n</editor-source>`
          : request.prompt,
      },
    ]
    active = {
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
    }
    activeRequests.set(key, active)
    const pending = active
    timer = setTimeout(() => {
      pending.timedOut = true
      pending.controller.abort()
    }, configuration.timeoutMs)
    const response = await requestCompletion(
      endpoint,
      JSON.stringify({ model: configuration.model, messages, stream: false }),
      configuration.apiKey,
      pending
    )
    if (pending.cancelled)
      throw new AssistantFailure('cancelled', 'Assistant request cancelled.')
    // A provider should not echo the authorization header, but never forward it if it does.
    const rawContent = readContent(response)
    const content = configuration.apiKey
      ? rawContent.split(configuration.apiKey).join('[redacted credential]')
      : rawContent
    return {
      success: true,
      requestId,
      content,
      codeBlocks: extractAssistantCodeBlocks(content),
    }
  } catch (error) {
    let failure: AssistantFailure
    if (active?.cancelled) {
      failure = new AssistantFailure(
        'cancelled',
        'Assistant request cancelled.'
      )
    } else if (active?.timedOut) {
      failure = new AssistantFailure(
        'timeout',
        'The assistant request timed out. Try again or increase the timeout in Assistant settings.'
      )
    } else if (error instanceof AssistantFailure) {
      failure = error
    } else {
      failure = new AssistantFailure(
        'network',
        'Could not reach the assistant provider. Check the endpoint, network connection, or whether your local provider is running.'
      )
    }
    return {
      success: false,
      requestId,
      error: failure.message,
      errorCode: failure.code,
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (active && activeRequests.get(key) === active) activeRequests.delete(key)
  }
}

/** Cancellation is scoped to the sender; another window cannot cancel its work. */
export function cancelAssistant(
  requestId: string,
  ownerId = 'desktop'
): boolean {
  if (!validRequestId(requestId)) return false
  const pending = activeRequests.get(`${ownerId}\0${requestId}`)
  if (!pending) return false
  pending.cancelled = true
  pending.controller.abort()
  return true
}

/** Call when a requesting webContents is destroyed or the application exits. */
export function cancelAllAssistantRequests(ownerId?: string): void {
  for (const [key, pending] of activeRequests) {
    if (ownerId === undefined || key.startsWith(`${ownerId}\0`)) {
      pending.cancelled = true
      pending.controller.abort()
    }
  }
}
