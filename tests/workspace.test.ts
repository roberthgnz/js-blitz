import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTab, loadTabs } from '../src/lib/workspace'

function storage(value?: unknown): Storage {
  return {
    getItem: (key: string) =>
      key === 'js-blitz-tabs' && value !== undefined
        ? JSON.stringify(value)
        : null,
  } as Storage
}

test('fresh browser and native workspaces use matching runtimes and welcome code', () => {
  const web = loadTabs(storage(), 'browser')[0]
  assert.equal(web.environment, 'browser')
  assert.match(web.code, /document.createElement/)
  assert.doesNotMatch(web.code, /node:/)
  const native = loadTabs(storage(), 'node')[0]
  assert.equal(native.environment, 'node')
  assert.match(native.code, /node:crypto/)
})

test('runtime selection survives loading mixed tabs without replacing their code', () => {
  const browser = createTab(1, 'document.title', 'browser')
  const node = createTab(2, 'process.version', 'node')
  const tabs = loadTabs(storage([browser, node]), 'browser')
  assert.deepEqual(tabs, [browser, node])
})

test('older tabs retain code and gain the host default environment', () => {
  const old = {
    id: 'saved-tab',
    name: 'Existing work',
    language: 'javascript',
    code: '40 + 2',
  }
  for (const environment of ['node', 'browser'] as const) {
    const [tab] = loadTabs(storage([old]), environment)
    assert.equal(tab.environment, environment)
    assert.equal(tab.code, old.code)
    assert.equal(tab.id, old.id)
  }
})
