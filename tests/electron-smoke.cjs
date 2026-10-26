/*
 * Runs the real bundled main/preload, renderer and IPC, with disposable userData.
 * Start Forge first, then: rtk pnpm exec electron tests/electron-smoke.cjs
 * Optional packaged renderer: JSBLITZ_SMOKE_MAIN=<resources/app/.vite/build/main.js>
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { app, BrowserWindow } = require('electron')

// Codex itself can inherit this flag from an Electron host. Relaunch only this
// harness with the flag removed; never mutate the Forge process environment.
if (!app) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 120000,
  })
  if (child.error) console.error(child.error)
  process.exit(child.status ?? 1)
}

const project = path.resolve(__dirname, '..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jsblitz-electron-smoke-'))
const mainPath = path.resolve(process.env.JSBLITZ_SMOKE_MAIN || path.join(project, '.vite/build/main.js'))
const screenshotPath = path.join(project, '.vite/desktop-smoke.png')
const reportPath = path.join(project, '.vite/desktop-smoke-report.json')
const results = []
const rendererErrors = []
const requests = []
let window
let fixture
let finishing = false

process.on('exit', code => {
  if (!finishing) console.error(`SMOKE process exited prematurely (${code}); ${results.length} tests completed`)
})
app.on('before-quit', () => { if (!finishing) console.error('SMOKE app before-quit before tests finished') })
app.on('window-all-closed', () => { if (!finishing) console.error('SMOKE all own windows closed before tests finished') })

app.setPath('userData', temporaryRoot)
app.on('browser-window-created', (_event, created) => {
  created.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) { rendererErrors.push(message); console.error(`SMOKE renderer error: ${message}`) }
  })
  created.webContents.on('preload-error', (_event, preload, error) => {
    rendererErrors.push(`preload ${preload}: ${error.message}`)
  })
  created.webContents.on('render-process-gone', (_event, detail) => {
    rendererErrors.push(`renderer exited: ${JSON.stringify(detail)}`)
  })
  created.webContents.on('did-fail-load', (_event, code, description, url) => console.error(`SMOKE load failed ${code} ${description} ${url}`))
  created.webContents.on('did-finish-load', () => console.log(`SMOKE loaded ${created.webContents.getURL()}`))
  created.on('closed', () => { if (!finishing) console.error('SMOKE own window closed unexpectedly') })
})

function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = source => bounded(window.webContents.executeJavaScript(`(async () => { ${source}\n})()`, true), 30000, 'renderer evaluation')

async function waitFor(source, label, ms = 15000) {
  const start = Date.now()
  let lastError
  while (Date.now() - start < ms) {
    try {
      const value = await evaluate(`return Boolean(${source})`)
      if (value) return value
    } catch (error) { lastError = error }
    await delay(80)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

async function test(name, fn) {
  const start = Date.now()
  try {
    const detail = await fn()
    results.push({ name, success: true, durationMs: Date.now() - start, ...(detail === undefined ? {} : { detail }) })
    console.log(`PASS ${name} (${Date.now() - start} ms)`)
  } catch (error) {
    results.push({ name, success: false, durationMs: Date.now() - start, error: error.stack || String(error) })
    console.error(`FAIL ${name}: ${error.stack || error}`)
    if (name.startsWith('real renderer')) {
      console.error('SMOKE renderer diagnostics', await evaluate(`return { scripts: [...document.scripts].map(script => script.src), resources: performance.getEntriesByType('resource').slice(-20).map(entry => ({ name: entry.name, duration: entry.duration, size: entry.transferSize })), html: document.body.innerHTML.slice(0, 1000) }`))
    }
  }
}

function execute(code, options = {}) {
  const request = { code, language: 'javascript', runId: randomUUID(), timeoutMs: 10000, ...options }
  return evaluate(`return window.electronAPI.executeCode(${JSON.stringify(request)})`)
}
const outputText = response => response.output.map(line => line.value.join(' ')).join('\n')

async function finish(fatal) {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  console.log('SMOKE finishing; capturing report')
  if (fatal) {
    results.push({ name: 'harness', success: false, error: fatal.stack || String(fatal) })
    console.error(fatal.stack || fatal)
    if (window && !window.isDestroyed()) {
      try { console.log('SMOKE fatal page state', await evaluate(`return { ready: document.readyState, api: typeof window.electronAPI, text: document.body.innerText.slice(0, 2000), html: document.body.innerHTML.slice(0, 2000) }`)) }
      catch (error) { console.error(`Page state unavailable: ${error.message}`) }
    }
  }
  try {
    if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
      const screenshot = await bounded(window.webContents.capturePage(), 5000, 'screenshot capture')
      fs.writeFileSync(screenshotPath, screenshot.toPNG())
    }
  } catch (error) { console.error(`Screenshot failed: ${error.message}`) }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify({ mainPath, processId: process.pid, temporaryRoot, rendererURL: window?.webContents.getURL(), results, rendererErrors, requests, screenshotPath }, null, 2))
  console.log('SMOKE report written; destroying own windows')
  app.removeAllListeners('window-all-closed')
  app.on('window-all-closed', () => {})
  for (const ownWindow of BrowserWindow.getAllWindows()) ownWindow.destroy()
  console.log('SMOKE own windows destroyed')
  if (fixture) {
    fixture.closeAllConnections()
    await bounded(new Promise(resolve => fixture.close(resolve)), 2000, 'fixture shutdown')
  }
  // Only the exact directory created above, directly within the OS temp folder.
  const resolved = path.resolve(temporaryRoot)
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase())
  assert.ok(path.basename(resolved).startsWith('jsblitz-electron-smoke-'))
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }) }
  catch (error) {
    results.push({ name: 'temporary userData cleanup', success: false, error: error.message })
    console.error(`Cleanup failed for ${resolved}: ${error.message}`)
  }
  const failed = results.filter(result => !result.success)
  console.log(`SMOKE RESULT: ${results.length - failed.length} passed; ${failed.length} failed; screenshot ${screenshotPath}`)
  app.exit(failed.length ? 1 : 0)
}

const deadline = setTimeout(() => void finish(new Error('Smoke suite exceeded the 115 second deadline')), 115000)
process.on('uncaughtException', error => void finish(error))
process.on('unhandledRejection', error => void finish(error))

// This must happen before ready so the real main registers its handlers/window.
require(mainPath)

async function run() {
  await app.whenReady()
  const start = Date.now()
  while (!BrowserWindow.getAllWindows().length && Date.now() - start < 15000) await delay(50)
  window = BrowserWindow.getAllWindows()[0]
  assert.ok(window, 'real main must create a BrowserWindow')
  window.setSize(1280, 850)
  window.show()
  window.webContents.setBackgroundThrottling(false)
  console.log(`SMOKE window created: ${window.webContents.getURL()}`)
  await waitFor(`window.electronAPI`, 'actual preload', 20000)
  console.log('SMOKE preload ready; page state:', await evaluate(`return { ready: document.readyState, text: document.body.innerText.slice(0, 1200), monaco: !!document.querySelector('.monaco-editor'), textarea: !!document.querySelector('.monaco-editor textarea') }`))
  await test('real renderer, sandboxed preload and default Run output', async () => {
    await waitFor(`document.querySelector('.monaco-editor textarea')`, 'Monaco', 10000)
    console.log('SMOKE Monaco ready')
    await evaluate(`
    const app = document.querySelector('#app').__vue_app__;
    const component = app._instance || app._container._vnode.component;
    window.__smoke = {
      root: component.setupState,
      setCode(code) { this.root.editor.setValue(code); },
      code() { return this.root.editor.getValue(); },
      click(selector) {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Missing element ' + selector);
        element.click();
      },
      input(selector, value) {
        const element = document.querySelector(selector);
        if (!element) throw new Error('Missing input ' + selector);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
    };
    return true;
    `)
    await waitFor(`window.__smoke.root.editor && document.querySelector('.output-content').textContent.includes('Hello from JSBlitz!')`, 'default live greeting', 10000)
    const state = await evaluate(`return {
      hasMonaco: !!document.querySelector('.monaco-editor textarea'),
      runVisible: [...document.querySelectorAll('button')].some(button => button.textContent.includes('Run') && button.getBoundingClientRect().width > 0),
      output: document.querySelector('.output-content').textContent,
      requireType: typeof window.require,
      processType: typeof window.process,
    }`)
    assert.equal(state.hasMonaco, true)
    assert.equal(state.runVisible, true)
    assert.match(state.output, /Hello from JSBlitz!|Hello/)
    assert.equal(state.requireType, 'undefined')
    assert.equal(state.processType, 'undefined')
    assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true)
    assert.equal(window.webContents.getLastWebPreferences().sandbox, true)
    return state.output.trim()
  })

  await test('JavaScript IPC: Node imports, require, TLA, console and expression results', async () => {
    const response = await execute(`import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
await delay(15)
console.log('node-smoke', basename('/tmp/example.js'), require('node:os').platform(), Buffer.from('ok').toString())
console.info('info-smoke')
console.warn('warn-smoke')
console.error('error-smoke')
40 + 2`)
    assert.equal(response.success, true, response.error)
    assert.match(outputText(response), /node-smoke example.js .* ok/)
    assert.ok(response.output.some(line => line.type === 'result' && line.value.includes('42')))
    for (const type of ['log', 'info', 'warn', 'error']) assert.ok(response.output.some(line => line.type === type), `missing console.${type}`)
    return response.output
  })

  await test('TypeScript IPC erases types and captures original result line', async () => {
    const response = await execute('interface Answer { value: number }\nconst answer: Answer = { value: 42 }\nanswer.value', { language: 'typescript' })
    assert.equal(response.success, true, response.error)
    assert.ok(response.output.some(line => line.type === 'result' && line.value.includes('42') && line.line === 3))
  })

  await test('unawaited timers remain alive and stream output over actual preload', async () => {
    const response = await evaluate(`
      const events = [];
      const runId = crypto.randomUUID();
      const dispose = window.electronAPI.on('execution-output', event => { if(event.runId === runId) events.push(event.output); });
      try {
        const response = await window.electronAPI.executeCode({ code: "console.log('first'); setTimeout(() => console.log('timer-later'), 90); void 0", runId, language: 'javascript', timeoutMs: 5000 });
        return { response, events };
      } finally { dispose(); }
    `)
    assert.equal(response.response.success, true, response.response.error)
    assert.match(outputText(response.response), /first[\s\S]*timer-later/)
    assert.ok(response.events.some(line => line.value.includes('first')))
    assert.ok(response.events.some(line => line.value.includes('timer-later')))
  })

  await test('actual worker timeout terminates infinite loop and preserves logs', async () => {
    const start = Date.now()
    const response = await execute("console.log('before-timeout'); while(true) {}", { timeoutMs: 1500 })
    assert.equal(response.success, false)
    assert.match(response.error, /timed out|timeout/i)
    assert.match(outputText(response), /before-timeout/)
    assert.ok(Date.now() - start < 7000)
    const next = await execute('6 * 7')
    assert.equal(next.success, true, next.error)
    assert.match(outputText(next), /42/)
  })

  await test('actual IPC cancellation kills running worker and retains prior logs', async () => {
    const value = await evaluate(`
      const runId = crypto.randomUUID();
      let resolveFirst;
      const first = new Promise(resolve => { resolveFirst = resolve; });
      const dispose = window.electronAPI.on('execution-output', event => { if (event.runId === runId && event.output.value.includes('before-cancel')) resolveFirst(); });
      const pending = window.electronAPI.executeCode({ code: "console.log('before-cancel'); await new Promise(resolve => setTimeout(resolve, 60000)); console.log('must-not-run')", runId, language: 'javascript', timeoutMs: 60000 });
      try {
        await Promise.race([first, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('No streamed pre-cancellation output')), 5000))]);
        await window.electronAPI.cancelExecution(runId);
        return await pending;
      } finally { dispose(); }
    `)
    assert.equal(value.success, false)
    assert.match(value.error, /cancel/i)
    assert.match(outputText(value), /before-cancel/)
    assert.doesNotMatch(outputText(value), /must-not-run/)
  })

  fixture = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, authorization: Boolean(request.headers.authorization), body: JSON.parse(body) })
      if (body.includes('slow-request')) return
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Fixture answer <img src=x onerror="window.__smokeInjected=true">\n```javascript\nconsole.log("AI-APPLY-MUST-NOT-EXECUTE")\n```' } }] }))
    })
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${fixture.address().port}/v1`

  await test('saved environment reaches execution and excludes disabled entries', async () => {
    const saved = await evaluate(`return window.electronAPI.saveDesktopSettings({
      environment: [
        { id: 'enabled', name: 'JSBLITZ_SMOKE_ENV', value: 'saved-value', enabled: true },
        { id: 'disabled', name: 'JSBLITZ_SMOKE_DISABLED', value: 'excluded-value', enabled: false },
      ],
      assistant: { endpoint: ${JSON.stringify(endpoint)}, model: 'local-smoke-fixture', timeoutMs: 5000 },
    })`)
    assert.equal(saved.success, true, saved.error)
    const settings = await evaluate('return window.electronAPI.getDesktopSettings()')
    assert.equal(settings.environment[0].value, 'saved-value')
    assert.equal(settings.assistant.hasApiKey, false)
    assert.ok(fs.existsSync(path.join(temporaryRoot, 'desktop-settings.json')))
    const response = await execute("console.log(process.env.JSBLITZ_SMOKE_ENV, process.env.JSBLITZ_SMOKE_DISABLED)", { env: { JSBLITZ_SMOKE_ENV: 'request-must-not-override' } })
    assert.equal(response.success, true, response.error)
    assert.match(outputText(response), /saved-value undefined/)
  })

  await test('assistant IPC calls a real local HTTP provider without credentials', async () => {
    const result = await evaluate(`return window.electronAPI.askAssistant({ requestId: 'smoke-ai', prompt: 'Explain this code', code: 'const answer = 42', history: [] })`)
    assert.equal(result.success, true, result.error)
    assert.equal(result.requestId, 'smoke-ai')
    assert.match(result.content, /Fixture answer/)
    assert.equal(result.codeBlocks[0].language, 'javascript')
    assert.match(result.codeBlocks[0].code, /AI-APPLY-MUST-NOT-EXECUTE/)
    assert.equal(requests[0].url, '/v1/chat/completions')
    assert.equal(requests[0].body.model, 'local-smoke-fixture')
    assert.equal(requests[0].authorization, false)
    assert.match(requests[0].body.messages.at(-1).content, /const answer = 42/)
  })

  await test('assistant cancellation reaches the actual HTTP request', async () => {
    const result = await evaluate(`
      const pending = window.electronAPI.askAssistant({ requestId: 'smoke-slow', prompt: 'slow-request', code: '' });
      await new Promise(resolve => setTimeout(resolve, 150));
      const cancelled = await window.electronAPI.cancelAssistant('smoke-slow');
      return { cancelled, response: await pending };
    `)
    assert.equal(result.cancelled, true)
    assert.equal(result.response.success, false)
    assert.equal(result.response.errorCode, 'cancelled')
  })

  await test('registry installation persists a CJS package and require works', async () => {
    await bounded(evaluate("return window.electronAPI.installPackage('is-number@7.0.0')"), 25000, 'is-number installation')
    const packages = await evaluate('return window.electronAPI.listPackages()')
    assert.ok(packages.some(item => item.name === 'is-number' && item.version === '7.0.0'))
    const response = await execute("import isNumber from 'is-number'; console.log(isNumber(42), require('is-number')('42'))")
    assert.equal(response.success, true, response.error)
    assert.match(outputText(response), /true true/)
  })

  await test('registry ESM package import and installed TypeScript declarations', async () => {
    await bounded(evaluate("return window.electronAPI.installPackage('nanoid@5.1.5')"), 25000, 'nanoid installation')
    const response = await execute("import { nanoid } from 'nanoid'; nanoid(8).length")
    assert.equal(response.success, true, response.error)
    assert.ok(response.output.some(line => line.value.includes('8')))
    const definitions = await evaluate('return window.electronAPI.getTypeDefinitions()')
    assert.ok(definitions.some(item => /nanoid.*\.d\.ts$/.test(item.path.replaceAll('\\', '/')) && /nanoid/.test(item.content)), 'nanoid declaration files must be exposed over IPC')
    return definitions.map(item => item.path)
  })

  await test('UI tabs preserve each Monaco model when switching', async () => {
    await evaluate(`if (document.querySelector('.live-toggle input').checked) document.querySelector('.live-toggle input').click(); window.__smoke.setCode('const originalTab = 41;\\noriginalTab + 1');`)
    await delay(100)
    const original = await evaluate(`return { id: document.querySelector('.tab-strip [role=tab][aria-selected=true]').id, code: window.__smoke.code() }`)
    await evaluate(`window.__smoke.click('.new-tab')`)
    await delay(150)
    await evaluate(`window.__smoke.setCode('const secondTab = "kept";\\nsecondTab')`)
    await delay(100)
    const second = await evaluate(`return { id: document.querySelector('.tab-strip [role=tab][aria-selected=true]').id, code: window.__smoke.code() }`)
    assert.notEqual(original.id, second.id)
    await evaluate(`window.__smoke.click(${JSON.stringify('#' )} + ${JSON.stringify(original.id)})`)
    await delay(150)
    assert.equal(await evaluate('return window.__smoke.code()'), original.code)
    await evaluate(`window.__smoke.click(${JSON.stringify('#')} + ${JSON.stringify(second.id)})`)
    await delay(150)
    assert.equal(await evaluate('return window.__smoke.code()'), second.code)
    const saved = await evaluate(`return JSON.parse(localStorage.getItem('js-blitz-tabs'))`)
    assert.ok(saved.some(tab => tab.code === original.code))
    assert.ok(saved.some(tab => tab.code === second.code))
  })

  await test('UI Run renders thrown HTML as literal error text', async () => {
    await evaluate(`window.__smoke.setCode('throw new Error(\'<img src=x onerror="window.__smokeInjected=true">\')');`)
    await delay(100)
    await evaluate(`window.__smoke.click('.workspace-toolbar .primary')`)
    await waitFor(`document.querySelector('.execution-error')?.textContent.includes('<img')`, 'literal execution error')
    const state = await evaluate(`return { text: document.querySelector('.execution-error').textContent, images: document.querySelectorAll('.execution-error img').length, injected: !!window.__smokeInjected }`)
    assert.match(state.text, /<img/)
    assert.equal(state.images, 0)
    assert.equal(state.injected, false)
  })

  await test('AI Apply opens a tab and disables Live before changing code', async () => {
    // Reload the real renderer so its already-mounted tools reload saved settings.
    window.webContents.reload()
    await waitFor(`document.querySelector('.monaco-editor textarea') && document.querySelector('.workspace-toolbar')`, 'renderer reload')
    await evaluate(`
      const root = document.querySelector('#app').__vue_app__._instance.setupState;
      window.__smoke = { root, code: () => root.editor.getValue() };
      [...document.querySelectorAll('.workspace-toolbar button')].find(button => button.textContent.includes('Environment')).click();
    `)
    await waitFor(`document.querySelector('.desktop-tools [role=tab]')`, 'desktop tools')
    await evaluate(`
      [...document.querySelectorAll('.desktop-tools [role=tab]')].find(button => /Assistant/.test(button.textContent)).click();
      const prompt = document.querySelector('.prompt-form textarea');
      prompt.value = 'Suggest a safe example';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    `)
    await delay(100)
    await evaluate(`document.querySelector('.prompt-form button[type=submit]').click()`)
    await waitFor(`document.querySelector('.apply-button')`, 'assistant response Apply button')
    await evaluate(`if (!document.querySelector('.live-toggle input').checked) document.querySelector('.live-toggle input').click();`)
    const before = await evaluate(`return { count: document.querySelectorAll('.tab-strip [role=tab]').length, live: document.querySelector('.live-toggle input').checked }`)
    assert.equal(before.live, true)
    await evaluate(`document.querySelector('.apply-button').click()`)
    await delay(1100)
    const after = await evaluate(`return {
      count: document.querySelectorAll('.tab-strip [role=tab]').length,
      live: document.querySelector('.live-toggle input').checked,
      code: window.__smoke.code(),
      output: document.querySelector('.output-content').textContent,
      injected: !!window.__smokeInjected,
      images: document.querySelectorAll('.message-content img').length,
    }`)
    assert.equal(after.count, before.count + 1)
    assert.equal(after.live, false)
    assert.match(after.code, /AI-APPLY-MUST-NOT-EXECUTE/)
    assert.doesNotMatch(after.output, /AI-APPLY-MUST-NOT-EXECUTE/)
    assert.equal(after.injected, false)
    assert.equal(after.images, 0)
    return after
  })

  await test('renderer/preload contain no startup or worker errors', async () => {
    assert.deepEqual(rendererErrors, [])
  })
  await finish()
}

run().catch(error => void finish(error))
