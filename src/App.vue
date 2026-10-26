<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import { useMonaco } from '@guolao/vue-monaco-editor'
import type * as Monaco from 'monaco-editor'
import { Pane, Splitpanes } from 'splitpanes'

import type { Output } from '../types'
import DesktopTools from './components/DesktopTools.vue'
import SnippetLibrary from './components/SnippetLibrary.vue'
import TitleBar from './components/TitleBar.vue'
import { configureEditor, refreshPackageTypes } from './lib/editor'
import { savedSnippets } from './lib/snippets'
import { getThemes } from './lib/themes'
import { createTab, loadTabs } from './lib/workspace'

const tabs = ref(loadTabs(localStorage))
const savedActive = localStorage.getItem('js-blitz-active-tab')
const activeId = ref(
  tabs.value.some((t) => t.id === savedActive) ? savedActive! : tabs.value[0].id
)
const activeTab = computed(
  () => tabs.value.find((t) => t.id === activeId.value) || tabs.value[0]
)
const code = computed({
  get: () => activeTab.value.code,
  set: (value) => {
    activeTab.value.code = value
  },
})
const { monacoRef } = useMonaco()
const editor = shallowRef<Monaco.editor.IStandaloneCodeEditor>()
const live = ref(localStorage.getItem('js-blitz-live') !== 'false')
const timeoutMs = ref(10000)
const toolsOpen = ref(false)
const theme = ref(localStorage.getItem('js-blitz-theme') || 'dracula')
const editorBackground = ref('#282a36')
const editorForeground = ref('#f8f8f2')
const outputs = ref<Record<string, Output[]>>({})
const errors = ref<Record<string, string>>({})
const running = ref<Record<string, string>>({})
const duration = ref<Record<string, number>>({})
const output = computed(() => outputs.value[activeId.value] || [])
const isRunning = computed(() => Boolean(running.value[activeId.value]))
const packageName = ref('')
const packages = ref<Array<{ name: string; version: string }>>([])
const packageBusy = ref(false)
const packageError = ref('')
const packagesOpen = ref(false)
const snippetsOpen = ref(false)
const problems = ref<Monaco.editor.IMarker[]>([])
const unsubscribers: Array<() => void> = []
let liveTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

watch(
  tabs,
  (value) => localStorage.setItem('js-blitz-tabs', JSON.stringify(value)),
  { deep: true }
)
watch(activeId, (value) => localStorage.setItem('js-blitz-active-tab', value))
watch(live, (value) => localStorage.setItem('js-blitz-live', String(value)))

function switchTab(id: string) {
  activeId.value = id
  nextTick(() => {
    editor.value?.focus()
    updateProblems()
  })
}
function newTab() {
  const tab = createTab(tabs.value.length + 1, '')
  tabs.value.push(tab)
  switchTab(tab.id)
}
function closeTab(id: string) {
  const index = tabs.value.findIndex((t) => t.id === id)
  if (index < 0) return
  if (running.value[id])
    void window.electronAPI.cancelExecution(running.value[id])
  tabs.value.splice(index, 1)
  if (!tabs.value.length) tabs.value.push(createTab(1, ''))
  if (activeId.value === id)
    activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)].id
  delete outputs.value[id]
  delete errors.value[id]
  delete running.value[id]
}
function updateProblems() {
  const model = editor.value?.getModel()
  problems.value =
    model && monacoRef.value
      ? monacoRef.value.editor.getModelMarkers({ resource: model.uri })
      : []
}
async function mountEditor(
  instance: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco
) {
  editor.value = instance
  const container = instance.getDomNode()?.parentElement
  if (container) {
    const resize = new ResizeObserver(() =>
      instance.layout({
        width: container.clientWidth,
        height: container.clientHeight,
      })
    )
    resize.observe(container)
    unsubscribers.push(() => resize.disconnect())
  }
  configureEditor(monaco)
  for (const language of ['javascript', 'typescript']) {
    const provider = monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model, position) {
        const word = model.getWordUntilPosition(position)
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        )
        return {
          suggestions: savedSnippets.value.map((snippet) => ({
            label: snippet.name,
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: snippet.description || 'Saved snippet',
            insertText: snippet.body,
            range,
          })),
        }
      },
    })
    unsubscribers.push(() => provider.dispose())
  }
  for (const item of await getThemes())
    monaco.editor.defineTheme(item.name, item.data)
  await setTheme(theme.value)
  instance.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
    () => void executeCode()
  )
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT, newTab)
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () =>
    closeTab(activeId.value)
  )
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () =>
    instance.trigger('zoom', 'editor.action.fontZoomIn', null)
  )
  instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () =>
    instance.trigger('zoom', 'editor.action.fontZoomOut', null)
  )
  const markers = monaco.editor.onDidChangeMarkers(updateProblems)
  unsubscribers.push(() => markers.dispose())
  await refreshPackageTypes(monaco)
  updateProblems()
  if (live.value) void executeCode()
}
async function setTheme(name: string) {
  const themes = await getThemes()
  const selected =
    themes.find((t) => t.name === name) ||
    themes.find((t) => t.name === 'dracula')!
  theme.value = selected.name
  localStorage.setItem('js-blitz-theme', selected.name)
  monacoRef.value?.editor.setTheme(selected.name)
  editorBackground.value =
    selected.data.colors['editor.background'] || '#282a36'
  editorForeground.value =
    selected.data.colors['editor.foreground'] || '#f8f8f2'
  localStorage.setItem('js-blitz-bg-color', editorBackground.value)
}
async function executeCode() {
  const tab = activeTab.value
  const id = tab.id
  clearTimeout(liveTimer)
  if (running.value[id])
    await window.electronAPI.cancelExecution(running.value[id])
  const runId = crypto.randomUUID()
  running.value[id] = runId
  outputs.value[id] = []
  errors.value[id] = ''
  const start = performance.now()
  try {
    const result = await window.electronAPI.executeCode({
      code: tab.code,
      language: tab.language,
      runId,
      timeoutMs: timeoutMs.value,
    })
    if (disposed || running.value[id] !== runId) return
    outputs.value[id] = result.output
    if (!result.success)
      errors.value[id] = result.error || 'Code execution failed.'
    duration.value[id] = Math.round(performance.now() - start)
    await loadPackages()
    if (monacoRef.value) await refreshPackageTypes(monacoRef.value)
  } catch (error) {
    if (running.value[id] === runId)
      errors.value[id] = error instanceof Error ? error.message : String(error)
  } finally {
    if (running.value[id] === runId) delete running.value[id]
  }
}
async function stopCode() {
  const runId = running.value[activeId.value]
  if (runId) await window.electronAPI.cancelExecution(runId)
}
watch(
  () => [activeId.value, activeTab.value.code, activeTab.value.language],
  (value, previous) => {
    clearTimeout(liveTimer)
    if (live.value && previous && value[0] === previous[0])
      liveTimer = setTimeout(() => void executeCode(), 700)
  }
)
function exportCode() {
  const tab = activeTab.value
  const url = URL.createObjectURL(new Blob([tab.code], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download =
    (tab.name.replace(/[^\w .-]/g, '_') || 'scratch') +
    (tab.language === 'typescript' ? '.ts' : '.js')
  link.click()
  URL.revokeObjectURL(url)
}
async function loadPackages() {
  packages.value = await window.electronAPI.listPackages()
}
async function installPackage() {
  if (!packageName.value.trim() || packageBusy.value) return
  packageBusy.value = true
  packageError.value = ''
  try {
    await window.electronAPI.installPackage(packageName.value.trim())
    packageName.value = ''
    await loadPackages()
    if (monacoRef.value) await refreshPackageTypes(monacoRef.value)
  } catch (error) {
    packageError.value = error instanceof Error ? error.message : String(error)
  } finally {
    packageBusy.value = false
  }
}
function insertCode(value: string) {
  live.value = false
  newTab()
  activeTab.value.name = 'AI suggestion'
  activeTab.value.code = value
}
function insertSnippet(value: string) {
  const selection = editor.value?.getSelection()
  if (selection)
    editor.value?.executeEdits('snippet', [
      { range: selection, text: value, forceMoveMarkers: true },
    ])
  editor.value?.focus()
}
function snippetInNewTab(value: string) {
  newTab()
  activeTab.value.code = value
}
function showSettings() {
  window.electronAPI.showContextMenu()
}
onMounted(() => {
  unsubscribers.push(
    window.electronAPI.on('set-theme', (name: string) => void setTheme(name))
  )
  unsubscribers.push(
    window.electronAPI.on(
      'execution-output',
      (event: { runId: string; output: Output }) => {
        const id = Object.keys(running.value).find(
          (id) => running.value[id] === event.runId
        )
        if (id) (outputs.value[id] ||= []).push(event.output)
      }
    )
  )
  void loadPackages().catch((error) => {
    packageError.value = String(error)
  })
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(liveTimer)
  unsubscribers.forEach((dispose) => dispose())
  Object.values(running.value).forEach(
    (id) => void window.electronAPI.cancelExecution(id)
  )
})
</script>

<template>
  <div
    class="desktop"
    :style="{
      '--editor-bg': editorBackground,
      '--editor-fg': editorForeground,
    }"
  >
    <TitleBar
      style="
        background: #20212b;
        --buttonForeground: #ddd;
        --buttonHoverForeground: #fff;
      "
    />
    <div class="workspace-toolbar">
      <button
        class="primary"
        :disabled="isRunning"
        @click="executeCode"
        title="Run code (Ctrl/Cmd+Enter)"
      >
        ▶ Run
      </button>
      <button :disabled="!isRunning" @click="stopCode">■ Stop</button>
      <label class="live-toggle"
        ><input v-model="live" type="checkbox" /> Live</label
      >
      <select v-model="activeTab.language" aria-label="Language">
        <option value="typescript">TypeScript</option>
        <option value="javascript">JavaScript</option>
      </select>
      <select v-model="timeoutMs" aria-label="Execution timeout">
        <option :value="10000">10 s limit</option>
        <option :value="30000">30 s limit</option>
        <option :value="60000">60 s limit</option>
      </select>
      <div class="toolbar-spacer" />
      <button
        :aria-expanded="packagesOpen"
        @click="packagesOpen = !packagesOpen"
      >
        Packages
      </button>
      <button
        :aria-expanded="snippetsOpen"
        @click="snippetsOpen = !snippetsOpen"
      >
        Snippets
      </button>
      <button :aria-expanded="toolsOpen" @click="toolsOpen = !toolsOpen">
        Environment &amp; AI
      </button>
      <button @click="showSettings" aria-label="Color theme and settings">
        ⚙
      </button>
    </div>
    <div class="tab-strip" role="tablist" aria-label="Code tabs">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeId }"
      >
        <button
          role="tab"
          :aria-selected="tab.id === activeId"
          :id="'tab-' + tab.id"
          @click="switchTab(tab.id)"
        >
          {{ running[tab.id] ? '◌ ' : '' }}{{ tab.name || 'Untitled' }}.{{
            tab.language === 'typescript' ? 'ts' : 'js'
          }}
        </button>
        <button @click="closeTab(tab.id)" :aria-label="'Close ' + tab.name">
          ×
        </button>
      </div>
      <button class="new-tab" @click="newTab" aria-label="New tab (Ctrl/Cmd+T)">
        +
      </button>
    </div>
    <div v-if="packagesOpen" class="package-panel">
      <form @submit.prevent="installPackage">
        <label for="package-name">npm package</label
        ><input
          id="package-name"
          v-model="packageName"
          placeholder="lodash, nanoid@5, @scope/package"
        /><button :disabled="packageBusy || !packageName.trim()">
          {{ packageBusy ? 'Installing…' : 'Install' }}
        </button>
      </form>
      <p class="hint">
        Imports install missing packages automatically. Installed packages are
        shared by all tabs.
      </p>
      <p v-if="packageError" class="error" role="alert">{{ packageError }}</p>
      <ul v-if="packages.length" class="package-list">
        <li v-for="pkg in packages" :key="pkg.name">
          {{ pkg.name }} <span>{{ pkg.version }}</span>
        </li>
      </ul>
      <p v-else class="hint">No packages installed yet.</p>
    </div>
    <SnippetLibrary
      v-show="snippetsOpen"
      :code="code"
      @insert="insertSnippet"
      @new-tab="snippetInNewTab"
    />
    <div class="workspace-body">
      <Splitpanes class="code-panes">
        <Pane :min-size="20" :size="55">
          <div
            class="editor-pane"
            role="tabpanel"
            :aria-labelledby="'tab-' + activeId"
          >
            <div class="pane-heading">
              <input
                v-model="activeTab.name"
                aria-label="Tab name"
                maxlength="80"
              /><button @click="exportCode">Export</button>
            </div>
            <VueMonacoEditor
              v-model:value="code"
              :path="
                'file:///workspace/' +
                activeId +
                (activeTab.language === 'typescript' ? '.ts' : '.js')
              "
              :language="activeTab.language"
              :theme="theme"
              :keep-current-model="true"
              :options="{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 14,
                tabSize: 2,
                scrollBeyondLastLine: false,
                formatOnPaste: true,
                suggestOnTriggerCharacters: true,
              }"
              @mount="mountEditor"
            />
          </div>
        </Pane>
        <Pane :min-size="15" :size="45">
          <div class="output-pane">
            <div class="pane-heading">
              <span
                >Output
                <span v-if="isRunning" class="running-indicator"
                  >Running…</span
                ></span
              ><button
                @click="
                  outputs[activeId] = []
                  errors[activeId] = ''
                "
              >
                Clear
              </button>
            </div>
            <div
              class="output-content"
              role="log"
              aria-label="Execution output"
            >
              <p
                v-if="!output.length && !errors[activeId]"
                class="empty-output"
              >
                Run your code with Ctrl/Cmd+Enter.<br />Expressions, console
                output and errors appear here.
              </p>
              <pre
                v-for="(line, index) in output"
                :key="index"
                class="output-line"
                :class="'output-' + line.type"
              ><span v-if="line.line" class="source-line">{{ line.line }}</span>{{ line.value.join(' ') }}</pre>
              <pre
                v-if="errors[activeId]"
                class="execution-error"
                role="alert"
                >{{ errors[activeId] }}</pre
              >
            </div>
          </div>
        </Pane>
      </Splitpanes>
      <aside v-show="toolsOpen" class="tools-panel" aria-label="Desktop tools">
        <DesktopTools :code="code" @insert-code="insertCode" />
      </aside>
    </div>
    <footer class="status-bar">
      <span
        >{{
          activeTab.language === 'typescript' ? 'TypeScript' : 'JavaScript'
        }}
        · Node.js</span
      ><button @click="editor?.getAction('editor.action.marker.next')?.run()">
        {{ problems.length }}
        {{ problems.length === 1 ? 'problem' : 'problems' }}</button
      ><span class="toolbar-spacer" /><span
        v-if="duration[activeId] !== undefined"
        >{{ duration[activeId] }} ms</span
      ><span>{{ isRunning ? 'Running' : 'Ready' }}</span>
    </footer>
  </div>
</template>

<style>
.desktop {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--editor-bg);
  color: var(--editor-fg);
  font-family: system-ui, sans-serif;
  font-size: 13px;
  color-scheme: dark;
}
.desktop button,
.desktop select,
.desktop input {
  font: inherit;
}
.desktop button {
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 5px 9px;
  cursor: pointer;
  color: inherit;
  white-space: nowrap;
}
.desktop button:hover {
  background: #ffffff13;
}
.desktop button:disabled {
  opacity: 0.4;
  cursor: default;
}
.desktop button:focus-visible,
.desktop input:focus-visible,
.desktop select:focus-visible {
  outline: 2px solid #bd93f9;
  outline-offset: -1px;
}
.workspace-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 8px 12px;
  background: #20212b;
  border-bottom: 1px solid #ffffff12;
}
.workspace-toolbar .primary {
  background: #bd93f9;
  color: #20212b;
  font-weight: 600;
}
.workspace-toolbar select {
  background: #30313e;
  padding: 5px;
  border: 1px solid #ffffff18;
  border-radius: 4px;
}
.live-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 6px;
}
.toolbar-spacer {
  flex: 1;
}
.tab-strip {
  display: flex;
  flex-shrink: 0;
  overflow-x: auto;
  background: #20212b;
  border-bottom: 1px solid #ffffff15;
}
.tab {
  display: flex;
  border-right: 1px solid #ffffff13;
  color: #aaa;
}
.tab.active {
  background: var(--editor-bg);
  color: var(--editor-fg);
  box-shadow: inset 0 2px #bd93f9;
}
.tab button {
  border-radius: 0;
  padding: 9px 10px;
}
.tab button + button {
  padding: 5px 8px;
}
.workspace-body {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.code-panes {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 100%;
}
.splitpanes__pane {
  min-width: 0;
  overflow: hidden;
}
.splitpanes__splitter {
  width: 5px;
  background: #20212b;
  cursor: col-resize;
  flex-shrink: 0;
}
.splitpanes__splitter:hover {
  background: #bd93f9;
}
.editor-pane,
.output-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.editor-pane .monaco-editor-container {
  flex: 1;
  min-height: 0;
}
.pane-heading {
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 12px;
  color: #a9aabb;
  font-size: 12px;
  border-bottom: 1px solid #ffffff0c;
}
.pane-heading input {
  background: transparent;
  border: 0;
  min-width: 0;
  width: 70%;
  color: inherit;
}
.output-content {
  padding: 12px 16px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.empty-output {
  color: #8c8d9f;
  line-height: 1.8;
}
.output-line,
.execution-error {
  font:
    13px/1.65 Consolas,
    'Courier New',
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0 0 7px;
}
.output-result {
  color: #bd93f9;
}
.output-error,
.execution-error,
.error {
  color: #ff8585;
}
.output-warn {
  color: #f1fa8c;
}
.output-info {
  color: #8be9fd;
}
.source-line {
  font-size: 10px;
  color: #858698;
  display: inline-block;
  min-width: 22px;
  user-select: none;
}
.running-indicator {
  color: #50fa7b;
  margin-left: 8px;
}
.status-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 2px 12px;
  min-height: 28px;
  font-size: 11px;
  color: #aaaabb;
  border-top: 1px solid #ffffff16;
  background: #20212b;
}
.status-bar button {
  font-size: 11px;
  padding: 2px 6px;
}
.tools-panel {
  width: 360px;
  min-width: 280px;
  max-width: 45%;
  overflow: auto;
  border-left: 1px solid #ffffff1a;
  background: #20212b;
}
.package-panel {
  padding: 12px 16px;
  border-bottom: 1px solid #ffffff1a;
  background: #232430;
  max-height: 200px;
  overflow: auto;
}
.package-panel form {
  display: flex;
  align-items: center;
  gap: 10px;
}
.package-panel input {
  background: #30313e;
  border: 1px solid #ffffff20;
  border-radius: 4px;
  padding: 6px 8px;
  min-width: 140px;
  flex: 1;
  max-width: 420px;
}
.hint {
  color: #aaaabb;
  font-size: 12px;
  margin: 8px 0;
}
.package-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 10px 0 0;
}
.package-list li {
  background: #ffffff0c;
  border: 1px solid #ffffff12;
  border-radius: 4px;
  padding: 3px 8px;
}
.package-list span {
  color: #aaaabb;
}
@media (max-width: 800px) {
  .workspace-toolbar {
    gap: 3px;
    padding: 6px;
  }
  .tools-panel {
    position: absolute;
    right: 0;
    top: 130px;
    bottom: 28px;
    z-index: 10;
    max-width: 95%;
    width: 360px;
    box-shadow: -8px 0 24px #0005;
  }
}
</style>
