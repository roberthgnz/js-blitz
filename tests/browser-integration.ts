/** Manual browser suite: http://127.0.0.1:1420/tests/browser-integration.html
 * No test framework, app internals, source mutations, or server setup required.
 * Read window.browserIntegration for machine-readable results.
 */
import { createBrowserExecution } from '../src/lib/browser-runner'
import type { BrowserExecution } from '../src/lib/browser-runner'
import type { ExecuteResponse, Output } from '../types'

type TestResult = {
  name: string
  passed: boolean
  detail: string
  elapsedMs: number
}
const results: TestResult[] = []
const report = { done: false, results, passed: 0, failed: 0 }
Object.assign(window, { browserIntegration: report })
const list = document.querySelector('#results')!
const previews = document.querySelector('#previews')!
const handles: BrowserExecution[] = []
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) throw new Error(message)
}
const text = (response: ExecuteResponse) =>
  response.output.flatMap((item) => item.value).join('\n')
async function test(name: string, run: () => Promise<string | void>) {
  const start = performance.now()
  const row = document.createElement('li')
  row.textContent = `${name}: running…`
  list.append(row)
  try {
    const detail = (await run()) || 'passed'
    results.push({
      name,
      passed: true,
      detail,
      elapsedMs: performance.now() - start,
    })
    row.className = 'pass'
    row.textContent = `PASS ${name}: ${detail}`
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    results.push({
      name,
      passed: false,
      detail,
      elapsedMs: performance.now() - start,
    })
    row.className = 'fail'
    row.textContent = `FAIL ${name}: ${detail}`
    console.error(name, error)
  }
}
function execution(
  code: string,
  language: 'javascript' | 'typescript' = 'javascript',
  label = '',
  timeoutMs = 6000
) {
  const output: Output[] = []
  const runId = crypto.randomUUID()
  const handle = createBrowserExecution(
    { code, language, runId, timeoutMs },
    (entry) => output.push(entry)
  )
  handles.push(handle)
  const host = document.createElement('section')
  if (label) {
    const title = document.createElement('h2')
    title.textContent = label
    host.append(title)
  }
  // The frame must be connected before awaiting its completion.
  host.append(handle.frame)
  previews.append(host)
  return { ...handle, output, host, runId }
}
async function until(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error(`Condition timed out after ${timeoutMs} ms`)
    await delay(25)
  }
}

async function main() {
  await test('Tauri-like parent CSP permits worker, frame and blob execution', async () => {
    const policy = document.querySelector<HTMLMetaElement>(
      'meta[http-equiv="Content-Security-Policy"]'
    )!.content
    const scriptPolicy =
      policy
        .split(';')
        .find((directive) => directive.trim().startsWith('script-src')) || ''
    assert(
      scriptPolicy.includes('blob:') &&
        !scriptPolicy.includes("'unsafe-inline'"),
      scriptPolicy
    )
    assert(policy.includes("frame-src 'self'"), policy)
    const run = execution(`console.log('csp-execution-ok');`)
    const response = await run.completion
    assert(
      response.success && text(response).includes('csp-execution-ok'),
      JSON.stringify(response)
    )
    run.dispose()
    return 'Meta parent policy only; a native frame response header requires a Tauri test'
  })
  await test('320 × 140 roundRect canvas and purple pixels', async () => {
    const run = execution(
      `
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 140;
      document.body.append(canvas);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#a855f7';
      [45, 80, 115, 65, 100].forEach((height, index) => {
        ctx.beginPath(); ctx.roundRect(15 + index * 60, 130 - height, 40, height, 6); ctx.fill();
      });
      console.log('canvas-size', canvas.width, canvas.height);
      console.log('purple-pixel', ...ctx.getImageData(30, 110, 1, 1).data);
      console.log('clear-pixel', ...ctx.getImageData(0, 0, 1, 1).data);
    `,
      'javascript',
      'Canvas bars'
    )
    const response = await run.completion
    assert(response.success, response.error || text(response))
    const output = text(response)
    assert(output.includes('canvas-size\n320\n140'), output)
    assert(output.includes('purple-pixel\n168\n85\n247\n255'), output)
    assert(output.includes('clear-pixel\n0\n0\n0\n0'), output)
    return 'Actual CanvasRenderingContext2D pixel is RGBA(168,85,247,255)'
  })
  await test('DOM output and TypeScript casts', async () => {
    const run = execution(
      `
      const element = document.createElement('strong') as HTMLElement;
      element.textContent = 'Real DOM is visible'; document.body.append(element);
      console.log('dom-proof', element.isConnected, document.body.innerText);
      (document.querySelector('strong') as HTMLElement).textContent;
    `,
      'typescript',
      'TypeScript DOM'
    )
    const response = await run.completion
    assert(response.success, response.error || text(response))
    assert(
      /dom-proof\s+true\s+Real DOM is visible/.test(text(response)),
      text(response)
    )
    assert(
      response.output.some(
        (entry) =>
          entry.type === 'result' && entry.value.includes('Real DOM is visible')
      ),
      text(response)
    )
  })
  await test('console, expression, top-level await, timers and DOM events', async () => {
    const run = execution(`
      console.log('console-ok'); 6 * 7;
      await new Promise(resolve => setTimeout(resolve, 10));
      console.info('await-ok');
      const button = document.createElement('button'); button.textContent = 'Click me'; document.body.append(button);
      button.addEventListener('click', () => { button.textContent = 'Clicked'; console.log('event-ok'); });
      setTimeout(() => { console.warn('timer-ok'); button.click(); }, 10);
    `)
    const response = await run.completion
    assert(response.success, response.error || text(response))
    for (const value of [
      'console-ok',
      '42',
      'await-ok',
      'timer-ok',
      'event-ok',
    ])
      assert(
        text(response).includes(value),
        `Missing ${value}: ${text(response)}`
      )
  })
  await test('DOM listeners stream output after initial completion', async () => {
    const run = execution(
      `window.addEventListener('message', (event) => { if (event.data === 'integration-event') console.log('late-event'); }); console.log('listener-ready');`
    )
    const response = await run.completion
    assert(response.success, response.error || text(response))
    run.frame.contentWindow!.postMessage('integration-event', '*')
    await until(() =>
      run.output.some((entry) => entry.value.includes('late-event'))
    )
  })
  await test('DOM exception retains earlier logs and frame', async () => {
    const run = execution(
      `console.log('before-dom-error'); document.body.append('Before error'); document.querySelector('missing').append('x');`
    )
    const response = await run.completion
    assert(!response.success && !!response.error, JSON.stringify(response))
    assert(text(response).includes('before-dom-error'), text(response))
    assert(run.frame.isConnected, 'Failure removed the DOM preview')
  })
  await test('opaque sandbox blocks parent DOM, cookies and bridge access', async () => {
    // A fake parent property proves isolation without invoking a real bridge.
    const parentWindow = window as unknown as Record<string, unknown>
    parentWindow.__browserIntegrationParentSecret = 'must-not-be-readable'
    const run = execution(`
      for (const [name, read] of [
        ['parent-document', () => parent.document],
        ['parent-secret', () => parent.__browserIntegrationParentSecret],
        ['parent-bridge', () => parent.__TAURI_INTERNALS__],
        ['cookies', () => document.cookie]
      ]) {
        try { read(); console.log(name, 'UNEXPECTED_ACCESS'); }
        catch (error) { console.log(name, error.name); }
      }
      console.log('child-bridge', typeof window.__TAURI__, typeof window.__TAURI_INTERNALS__, typeof window.ipc);
    `)
    try {
      const response = await run.completion
      assert(response.success, response.error || text(response))
      assert(
        run.frame.getAttribute('sandbox') === 'allow-scripts',
        'Sandbox token changed'
      )
      for (const name of [
        'parent-document',
        'parent-secret',
        'parent-bridge',
        'cookies',
      ])
        assert(
          text(response).includes(`${name}\nSecurityError`),
          text(response)
        )
      assert(
        text(response).includes(
          'child-bridge\nundefined\nundefined\nundefined'
        ),
        text(response)
      )
      return 'Observed browser origin isolation only; native IPC security is not covered'
    } finally {
      delete parentWindow.__browserIntegrationParentSecret
    }
  })
  await test('spoofed window.postMessage cannot inject output or completion', async () => {
    const run = execution(`
      parent.postMessage({kind:'output', output:{type:'log',value:['SPOOFED_CHILD']}}, '*');
      await new Promise(resolve => setTimeout(resolve, 60)); console.log('real-output');
    `)
    window.postMessage(
      {
        kind: 'output',
        runId: run.runId,
        output: { type: 'log', value: ['SPOOFED_PARENT'] },
      },
      '*'
    )
    window.postMessage(
      { kind: 'complete', runId: run.runId, success: false, error: 'spoof' },
      '*'
    )
    run.frame.contentWindow!.postMessage(
      {
        kind: 'execute',
        runId: run.runId,
        code: "console.log('SPOOFED_EXECUTE')",
      },
      '*'
    )
    const response = await run.completion
    assert(
      response.success && text(response).includes('real-output'),
      JSON.stringify(response)
    )
    assert(!text(response).includes('SPOOFED'), text(response))
  })
  await test('rerun receives a fresh document and globals', async () => {
    const first = execution(
      `window.previousRun = 123; document.body.id = 'old-run'; console.log('first');`
    )
    assert((await first.completion).success, 'First run failed')
    first.dispose()
    const next = execution(
      `console.log('fresh-document', document.body.id === '', window.previousRun === undefined);`
    )
    const response = await next.completion
    assert(
      response.success && text(response).includes('fresh-document\ntrue\ntrue'),
      JSON.stringify(response)
    )
  })
  await test('cancel removes frame and stops asynchronous work', async () => {
    const run = execution(
      `console.log('cancel-started'); setTimeout(() => console.log('SHOULD_NOT_RUN'), 500);`
    )
    await until(() =>
      run.output.some((entry) => entry.value.includes('cancel-started'))
    )
    run.cancel()
    const response = await run.completion
    assert(
      !response.success && /cancel/i.test(response.error || ''),
      JSON.stringify(response)
    )
    assert(!run.frame.isConnected, 'Cancelled frame remains connected')
    const count = run.output.length
    await delay(550)
    assert(run.output.length === count, 'Output continued after cancellation')
  })
  await test('AST guard terminates while(true)', async () => {
    const start = performance.now()
    const run = execution(
      `console.log('before-loop'); while (true) {}`,
      'javascript',
      '',
      3000
    )
    const response = await run.completion
    assert(
      !response.success && /synchronous time limit/i.test(response.error || ''),
      JSON.stringify(response)
    )
    assert(text(response).includes('before-loop'), text(response))
    assert(
      performance.now() - start < 3000,
      'Guard did not bound synchronous execution'
    )
  })
  await test('compiler errors settle without running code', async () => {
    const run = execution(`const broken: = ;`, 'typescript')
    const response = await run.completion
    assert(!response.success && !!response.error, JSON.stringify(response))
    assert(
      response.output.some((entry) => entry.type === 'error'),
      JSON.stringify(response)
    )
    run.dispose()
  })
  if (new URLSearchParams(location.search).has('ui')) {
    await test('standalone app defaults Browser and disables Node.js', async () => {
      const app = document.createElement('iframe')
      app.id = 'app-check'
      app.src = '/'
      previews.append(app)
      await until(
        () =>
          !!app.contentDocument?.querySelector(
            'select[aria-label="Execution environment"]'
          ),
        12000
      )
      const selector = app.contentDocument!.querySelector<HTMLSelectElement>(
        'select[aria-label="Execution environment"]'
      )!
      assert(
        selector.value === 'browser',
        `Current environment is ${selector.value}; existing persisted state may affect this check`
      )
      assert(
        selector.querySelector<HTMLOptionElement>('option[value="node"]')
          ?.disabled,
        'Node.js is enabled in standalone web'
      )
    })
    await test('Monaco public worker accepts document and canvas types', async () => {
      // Import the same public modules as renderer.ts; never inspect Vue internals.
      const monaco = await import('monaco-editor/esm/vs/editor/edcore.main')
      await import(
        'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
      )
      await import(
        'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
      )
      await import(
        'monaco-editor/esm/vs/language/typescript/monaco.contribution'
      )
      const [
        { configureEditor, setEditorEnvironment },
        { default: EditorWorker },
        { default: TypeScriptWorker },
      ] = await Promise.all([
        import('../src/lib/editor'),
        import('monaco-editor/esm/vs/editor/editor.worker?worker'),
        import('../src/lib/typescript.worker?worker'),
      ])
      self.MonacoEnvironment = {
        getWorker: (_id, label) =>
          label === 'typescript' || label === 'javascript'
            ? new TypeScriptWorker()
            : new EditorWorker(),
      }
      configureEditor(monaco)
      setEditorEnvironment(monaco, 'browser')
      const model = monaco.editor.createModel(
        `const canvas = document.createElement('canvas'); canvas.width = 320; const ctx = canvas.getContext('2d')!; ctx.roundRect(0, 0, 10, 10, 2);`,
        'typescript',
        monaco.Uri.parse('file:///workspace/browser-integration.ts')
      )
      try {
        let worker:
          | import('monaco-editor').languages.typescript.TypeScriptWorker
          | undefined
        await until(() =>
          Boolean(
            monaco.languages
              .getLanguages()
              .some((language) => language.id === 'typescript')
          )
        )
        const deadline = performance.now() + 5000
        while (!worker) {
          try {
            worker = await (
              await monaco.languages.typescript.getTypeScriptWorker()
            )(model.uri)
          } catch (error) {
            if (performance.now() > deadline) throw error
            await delay(50)
          }
        }
        const diagnostics = await worker.getSemanticDiagnostics(
          model.uri.toString()
        )
        assert(diagnostics.length === 0, JSON.stringify(diagnostics))
      } finally {
        model.dispose()
      }
    })
  }
  report.done = true
  report.passed = results.filter((entry) => entry.passed).length
  report.failed = results.length - report.passed
  document.querySelector('#summary')!.textContent =
    `${report.passed} passed, ${report.failed} failed. Reload to rerun.`
}
window.addEventListener('pagehide', () =>
  handles.forEach((handle) => handle.dispose())
)
void main().catch((error) => {
  report.done = true
  document.querySelector('#summary')!.textContent =
    `Harness failed: ${String(error)}`
  console.error(error)
})
