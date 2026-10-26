import type { ExecuteResponse, Output } from '../../types'

export interface BrowserExecutionRequest {
  code: string
  language: 'javascript' | 'typescript'
  runId: string
  timeoutMs?: number
}

export interface BrowserExecution {
  frame: HTMLIFrameElement
  completion: Promise<ExecuteResponse>
  cancel(): void
  dispose(): void
}

const outputTypes = new Set(['log', 'info', 'warn', 'error', 'result'])
const DEFAULT_TIMEOUT = 10_000

/** No user code is evaluated in the renderer, including during compilation. */
export function createBrowserExecution(
  request: BrowserExecutionRequest,
  onOutput?: (output: Output) => void
): BrowserExecution {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'")
  frame.title = 'Browser preview'
  frame.src = new URL('browser-frame.html', document.baseURI).href

  const timeoutMs = Number.isFinite(request.timeoutMs)
    ? Math.min(Math.max(request.timeoutMs!, 25), 120_000) : DEFAULT_TIMEOUT
  const output: Output[] = []
  let outputSize = 0
  let resolve!: (response: ExecuteResponse) => void
  const completion = new Promise<ExecuteResponse>((done) => { resolve = done })
  let settled = false
  let disposed = false
  let connected = false
  let ready = false
  let executing = false
  let code: string | undefined
  let worker: Worker | undefined
  let channel: MessageChannel | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const suffix = crypto.randomUUID().replace(/-/g, '')
  const resultName = `__jsblitz_result_${suffix}`
  const guardName = `__jsblitz_guard_${suffix}`

  const emit = (entry: Output) => {
    if (disposed) return
    if (output.length >= 10_000 || outputSize >= 4 * 1024 * 1024) return
    output.push(entry)
    outputSize += entry.value.reduce((size, value) => size + value.length, 0)
    try { onOutput?.(entry) } catch { /* A UI subscriber must not interrupt execution. */ }
  }
  const finish = (success: boolean, error?: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    worker?.terminate()
    worker = undefined
    // Keep the frame and channel alive for DOM events and animations.
    resolve({ success, output: [...output], ...(error ? { error } : {}) })
  }
  const release = () => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    worker?.terminate()
    worker = undefined
    frame.removeEventListener('load', connect)
    frame.removeEventListener('error', loadError)
    if (channel) {
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
    }
    frame.remove()
    // Also stops a frame that the caller has not appended yet.
    frame.src = 'about:blank'
  }
  const fail = (message: string, removeFrame = false) => {
    if (disposed) return
    emit({ type: 'error', value: [message] })
    finish(false, message)
    if (removeFrame) release()
  }
  const start = () => {
    if (disposed || settled || executing || !ready || code === undefined || !channel) return
    executing = true
    channel.port1.postMessage({ kind: 'execute', runId: request.runId, code, resultName, guardName, timeoutMs })
  }
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (disposed || !data || typeof data !== 'object') return
    const message = data as Record<string, unknown>
    if (message.runId !== request.runId) return
    if (message.kind === 'ready') { ready = true; start(); return }
    if (message.kind === 'output') {
      const entry = message.output as Output | undefined
      if (entry && outputTypes.has(entry.type) && Array.isArray(entry.value) &&
        entry.value.length <= 100 && entry.value.every((value) => typeof value === 'string') &&
        (entry.line === undefined || (Number.isSafeInteger(entry.line) && entry.line > 0)))
        emit({ type: entry.type, value: entry.value, ...(entry.line ? { line: entry.line } : {}) })
    } else if (message.kind === 'complete' && typeof message.success === 'boolean') {
      finish(message.success, typeof message.error === 'string' ? message.error : undefined)
    }
  }
  function connect() {
    if (disposed) return
    if (connected) { fail('The browser preview navigated away from the running snippet.', true); return }
    if (!frame.contentWindow) { fail('Could not initialize the browser preview.', true); return }
    connected = true
    channel = new MessageChannel()
    channel.port1.onmessage = receive
    channel.port1.start()
    frame.contentWindow.postMessage({ kind: 'jsblitz-connect', runId: request.runId }, '*', [channel.port2])
  }
  function loadError() { fail('Could not load the isolated browser preview.', true) }
  frame.addEventListener('load', connect)
  frame.addEventListener('error', loadError)
  timer = setTimeout(() => fail(`Browser execution timed out after ${timeoutMs} ms.`, true), timeoutMs)

  // Defer setup so the caller always receives the handle before any output.
  queueMicrotask(() => {
    if (disposed || settled) return
    try {
      worker = new Worker(new URL('./browser-compiler.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = ({ data }: MessageEvent<{ success?: boolean; code?: string; error?: string }>) => {
        if (disposed || settled) return
        worker?.terminate()
        worker = undefined
        if (!data.success || typeof data.code !== 'string') {
          fail(data.error || 'Browser compilation failed.')
          return
        }
        code = data.code
        start()
      }
      worker.onerror = (event) => {
        event.preventDefault()
        fail(event.message || 'Could not start the browser compiler worker.')
      }
      worker.postMessage({ code: request.code, language: request.language, resultName, guardName })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })
  const stop = () => {
    if (!settled) finish(false, 'Browser execution cancelled')
    release()
  }
  return { frame, completion, cancel: stop, dispose: stop }
}
