import type { Output } from '../types'

// This entry is emitted as a classic, self-contained script. In particular it
// must never import the app, the desktop bridge, or a Node compatibility shim.
(() => {
  const nativeSetTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const nativeSetInterval = window.setInterval.bind(window)
  const nativeClearInterval = window.clearInterval.bind(window)
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window)
  const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window)
  const now = performance.now.bind(performance)
  const pendingTimers = new Set<number>()
  const intervals = new Set<number>()
  const animationFrames = new Set<number>()
  let port: MessagePort | undefined
  let runId: string | undefined
  let started = false
  let finished = false
  let moduleFinished = false
  let pendingPromises = 0
  let outputCount = 0
  let outputSize = 0
  let completionTimer: number | undefined
  let guardTimer: number | undefined
  let guardDeadline = 0
  let guardTicks = 0
  let synchronousLimit = 250

  // Defense in depth if a webview injects its bridge in child documents.
  // The opaque sandbox origin also prevents access to the parent's globals.
  const globals = window as unknown as Record<string, unknown>
  const bridgeNames = [
    '__TAURI__', '__TAURI_INTERNALS__', '__TAURI_IPC__',
    '__TAURI_METADATA__', '__TAURI_EVENT_PLUGIN_INTERNALS__', 'ipc',
  ]
  for (const name of bridgeNames) {
    try { delete globals[name] } catch { /* Some webviews define readonly globals. */ }
    if (globals[name] !== undefined) {
      try { Object.defineProperty(window, name, { value: undefined }) } catch { /* Checked before executing. */ }
    }
  }

  function serialize(value: unknown): string {
    const ancestors = new WeakSet<object>()
    let remaining = 20_000
    const render = (item: unknown, depth: number, nested = false): string => {
      if (remaining <= 0) return '…'
      remaining -= 8
      if (item === null) return 'null'
      if (typeof item === 'string') {
        const text = item.length > Math.min(remaining, 20_000)
          ? item.slice(0, Math.max(0, Math.min(remaining, 20_000))) + '…' : item
        remaining -= text.length
        return nested ? JSON.stringify(text) : text
      }
      if (typeof item === 'bigint') return `${item}n`
      if (typeof item === 'symbol') return String(item)
      if (typeof item === 'function') {
        const name = Object.getOwnPropertyDescriptor(item, 'name')?.value
        return `[Function${typeof name === 'string' && name ? `: ${name}` : ''}]`
      }
      if (typeof item !== 'object') return String(item)
      if (ancestors.has(item)) return '[Circular]'
      if (depth >= 6) return '[Object]'
      ancestors.add(item)
      try {
        if (item instanceof Error) {
          const message = Object.getOwnPropertyDescriptor(item, 'message')?.value
          const stack = Object.getOwnPropertyDescriptor(item, 'stack')?.value
          return typeof stack === 'string' ? stack.slice(0, 20_000)
            : `Error${typeof message === 'string' ? `: ${message.slice(0, 20_000)}` : ''}`
        }
        if (item instanceof Node) return `[${item.nodeName}]`
        if (item instanceof Map) {
          const entries: string[] = []
          Map.prototype.forEach.call(item, (entry: unknown, key: unknown) => {
            if (entries.length < 100 && remaining > 0)
              entries.push(`${render(key, depth + 1, true)} => ${render(entry, depth + 1, true)}`)
          })
          return `Map(${item.size}) { ${entries.join(', ')}${item.size > entries.length ? ', …' : ''} }`
        }
        if (item instanceof Set) {
          const entries: string[] = []
          Set.prototype.forEach.call(item, (entry: unknown) => {
            if (entries.length < 100 && remaining > 0) entries.push(render(entry, depth + 1, true))
          })
          return `Set(${item.size}) { ${entries.join(', ')}${item.size > entries.length ? ', …' : ''} }`
        }
        if (item instanceof Date) return Date.prototype.toISOString.call(item)
        if (item instanceof RegExp) return RegExp.prototype.toString.call(item)
        if (item instanceof Promise) return 'Promise { <pending> }'
        const array = Array.isArray(item)
        const entries: string[] = []
        // Read descriptors rather than invoking getters, toJSON or custom inspect.
        const keys = Reflect.ownKeys(item)
        for (const key of keys) {
          if (array && key === 'length') continue
          const descriptor = Object.getOwnPropertyDescriptor(item, key)
          if (!descriptor?.enumerable) continue
          if (entries.length >= 100 || remaining <= 0) { entries.push('…'); break }
          const entry = 'value' in descriptor
            ? render(descriptor.value, depth + 1, true) : '[Getter]'
          entries.push(array ? entry : `${String(key)}: ${entry}`)
        }
        return array ? `[ ${entries.join(', ')} ]` : `{ ${entries.join(', ')} }`
      } finally {
        ancestors.delete(item)
      }
    }
    try { return render(value, 0).slice(0, 24_000) }
    catch { return '[Unserializable value]' }
  }

  function send(message: Record<string, unknown>) {
    port?.postMessage({ ...message, runId })
  }
  function emit(type: Output['type'], values: unknown[], line?: number) {
    if (outputCount >= 10_000 || outputSize >= 4 * 1024 * 1024) {
      if (outputCount === 10_000) {
        send({ kind: 'output', output: { type: 'warn', value: ['Output truncated: execution output limit reached.'] } })
        outputCount++
      }
      return
    }
    const value = values.slice(0, 100).map(serialize)
    outputCount++
    outputSize += value.reduce((size, entry) => size + entry.length, 0)
    send({ kind: 'output', output: { type, value, ...(line ? { line } : {}) } })
  }
  function complete(success: boolean, error?: string) {
    if (finished) return
    finished = true
    send({ kind: 'complete', success, ...(error ? { error } : {}) })
  }
  function fail(error: unknown) {
    const text = serialize(error)
    emit('error', [text])
    const message = error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined
    complete(false, typeof message === 'string' ? message : text)
  }
  function checkCompletion() {
    if (finished || !moduleFinished || pendingTimers.size || pendingPromises || completionTimer !== undefined) return
    // A task boundary lets unhandled rejections and queued timers report first.
    completionTimer = nativeSetTimeout(() => {
      completionTimer = undefined
      if (!pendingTimers.size && !pendingPromises) complete(true)
    }, 0)
  }
  function observePromise(value: PromiseLike<unknown>, onValue?: (value: unknown) => void) {
    pendingPromises++
    void Promise.resolve(value).then(onValue, fail).finally(() => {
      pendingPromises--
      checkCompletion()
    })
  }
  function invokeCallback(callback: (...args: unknown[]) => unknown, args: unknown[]) {
    try {
      const result = callback(...args)
      if (result instanceof Promise) observePromise(result)
    } catch (error) { fail(error) }
    checkCompletion()
  }
  function guard() {
    // Keep the check cheap inside tight loops while still bounding each task.
    if ((guardTicks++ & 127) !== 0) return
    if (guardTimer === undefined) {
      guardDeadline = now() + synchronousLimit
      guardTimer = nativeSetTimeout(() => { guardTimer = undefined; guardTicks = 0 }, 0)
    }
    if (now() > guardDeadline)
      throw new Error(`Browser execution exceeded the synchronous time limit (${synchronousLimit} ms). Yield to the event loop during long work.`)
  }
  function installRuntime(resultName: string, guardName: string) {
    Object.defineProperty(window, guardName, { value: guard, configurable: false, writable: false })
    Object.defineProperty(window, resultName, {
      value: (value: unknown, line: number) => {
        if (value instanceof Promise)
          observePromise(value, (resolved) => { if (resolved !== undefined) emit('result', [resolved], line) })
        else if (value !== undefined) emit('result', [value], line)
        return value
      },
      configurable: false,
      writable: false,
    })
    for (const type of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table', 'trace'] as const)
      console[type] = (...values: unknown[]) => emit(
        ['debug', 'dir', 'table', 'trace'].includes(type) ? 'log' : type as Output['type'], values)
    console.assert = (condition: unknown, ...values: unknown[]) => {
      if (!condition) emit('error', ['Assertion failed:', ...values])
    }
    console.clear = () => undefined
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw new TypeError('Browser snippets must pass a function to setTimeout().')
      const id = nativeSetTimeout(() => {
        pendingTimers.delete(id)
        invokeCallback(callback as (...args: unknown[]) => unknown, args)
      }, delay)
      pendingTimers.add(id)
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => {
      if (id !== undefined) { pendingTimers.delete(id); intervals.delete(id) }
      nativeClearTimeout(id)
      checkCompletion()
    }) as typeof window.clearTimeout
    window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') throw new TypeError('Browser snippets must pass a function to setInterval().')
      const id = nativeSetInterval(() => invokeCallback(callback as (...args: unknown[]) => unknown, args), delay)
      intervals.add(id)
      return id
    }) as typeof window.setInterval
    window.clearInterval = ((id?: number) => {
      if (id !== undefined) { intervals.delete(id); pendingTimers.delete(id) }
      nativeClearInterval(id)
      checkCompletion()
    }) as typeof window.clearInterval
    window.requestAnimationFrame = (callback) => {
      const id = nativeRequestAnimationFrame((timestamp: number) => {
        animationFrames.delete(id)
        invokeCallback(callback as (...args: unknown[]) => unknown, [timestamp])
      })
      animationFrames.add(id)
      return id
    }
    window.cancelAnimationFrame = (id) => {
      animationFrames.delete(id)
      nativeCancelAnimationFrame(id)
    }
    window.addEventListener('error', (event) => { event.preventDefault(); fail(event.error || event.message) })
    window.addEventListener('unhandledrejection', (event) => { event.preventDefault(); fail(event.reason) })
    // Suppress navigation and form submission; previews remain in this sandbox.
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault()
    }, true)
    document.addEventListener('submit', (event) => event.preventDefault(), true)
  }
  async function execute(message: Record<string, unknown>) {
    if (started || message.runId !== runId || typeof message.code !== 'string' ||
      typeof message.resultName !== 'string' || typeof message.guardName !== 'string') return
    started = true
    if (bridgeNames.some((name) => globals[name] !== undefined)) {
      fail(new Error('This webview exposed a native bridge to the preview; execution was blocked.'))
      return
    }
    synchronousLimit = Math.min(250, typeof message.timeoutMs === 'number' ? message.timeoutMs : 250)
    installRuntime(message.resultName, message.guardName)
    const url = URL.createObjectURL(new Blob([message.code], { type: 'text/javascript' }))
    try {
      const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>
      await importModule(url)
      moduleFinished = true
      checkCompletion()
    } catch (error) { fail(error) }
    finally { URL.revokeObjectURL(url) }
  }
  window.addEventListener('message', function connect(event: MessageEvent<unknown>) {
    if (port || event.source !== parent || !event.data || typeof event.data !== 'object') return
    const message = event.data as Record<string, unknown>
    if (message.kind !== 'jsblitz-connect' || typeof message.runId !== 'string' || event.ports.length !== 1) return
    runId = message.runId
    port = event.ports[0]
    port.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (data && typeof data === 'object' && (data as Record<string, unknown>).kind === 'execute')
        void execute(data as Record<string, unknown>).catch(fail)
    }
    port.start()
    send({ kind: 'ready' })
    window.removeEventListener('message', connect)
  })
})()
