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
import { useMonaco, VueMonacoEditor } from '@guolao/vue-monaco-editor'
import type * as Monaco from 'monaco-editor'
import { Pane, Splitpanes } from 'splitpanes'

import type { Output } from '../types'
import CommandPalette, {
  type PaletteCommand,
} from './components/CommandPalette.vue'
import DesktopTools from './components/DesktopTools.vue'
import Icon, { type IconName } from './components/Icon.vue'
import PackagesPanel from './components/PackagesPanel.vue'
import SnippetLibrary from './components/SnippetLibrary.vue'
import TitleBar from './components/TitleBar.vue'
import { desktopAPI } from './lib/desktop'
import { configureEditor, refreshPackageTypes } from './lib/editor'
import { savedSnippets } from './lib/snippets'
import { getThemes, getUiPalette, type UiPalette } from './lib/themes'
import { createTab, loadTabs } from './lib/workspace'

type Panel = 'packages' | 'snippets' | 'environment' | 'assistant'
const PANELS: Array<{ id: Panel; label: string; icon: IconName }> = [
  { id: 'packages', label: 'Packages', icon: 'package' },
  { id: 'snippets', label: 'Snippets', icon: 'bookmark' },
  { id: 'environment', label: 'Environment', icon: 'braces' },
  { id: 'assistant', label: 'AI Assistant', icon: 'sparkles' },
]
const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'

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
const theme = ref(localStorage.getItem('js-blitz-theme') || 'dracula')
const palette = ref<UiPalette>(loadPalette())
const themeList = ref<
  Array<{ name: string; label: string; palette: UiPalette }>
>([])
const outputs = ref<Record<string, Output[]>>({})
const errors = ref<Record<string, string>>({})
const running = ref<Record<string, string>>({})
const duration = ref<Record<string, number>>({})
const output = computed(() => outputs.value[activeId.value] || [])
const isRunning = computed(() => Boolean(running.value[activeId.value]))
const packages = ref<Array<{ name: string; version: string }>>([])
const packageBusy = ref(false)
const packageError = ref('')
const installingPackages = ref(false)
const packagesPanel = ref<InstanceType<typeof PackagesPanel> | null>(null)
const snippetLibrary = ref<InstanceType<typeof SnippetLibrary> | null>(null)
const savedPanel = localStorage.getItem('js-blitz-panel')
const panel = ref<Panel | null>(
  PANELS.some((p) => p.id === savedPanel) ? (savedPanel as Panel) : null
)
// DesktopTools stays mounted (it owns chat and draft state) across panels.
const toolsView = ref<'environment' | 'assistant'>(
  panel.value === 'assistant' ? 'assistant' : 'environment'
)
const sidebarWidth = ref(
  Math.min(
    Math.max(
      Number(localStorage.getItem('js-blitz-sidebar-width')) || 340,
      260
    ),
    560
  )
)
const paletteOpen = ref(false)
const themeMenuOpen = ref(false)
const editingTabId = ref('')
const tabNameDraft = ref('')
const tabStrip = ref<HTMLElement | null>(null)
const copied = ref(false)
const cursor = ref({ line: 1, column: 1 })
const problems = ref<Monaco.editor.IMarker[]>([])
const unsubscribers: Array<() => void> = []
let liveTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false

const problemCounts = computed(() => ({
  errors: problems.value.filter((m) => m.severity >= 8).length,
  warnings: problems.value.filter((m) => m.severity === 4).length,
}))
const runState = computed(() =>
  isRunning.value
    ? 'running'
    : errors.value[activeId.value]
      ? 'error'
      : duration.value[activeId.value] !== undefined
        ? 'success'
        : 'idle'
)
const extension = computed(() =>
  activeTab.value.language === 'typescript' ? 'ts' : 'js'
)

function loadPalette(): UiPalette {
  try {
    const stored = JSON.parse(localStorage.getItem('js-blitz-ui-palette') || '')
    if (stored && typeof stored['--ui-bg'] === 'string') return stored
  } catch {
    /* Fall back to the default theme until the saved one loads. */
  }
  return getUiPalette('dracula', {})
}

watch(
  tabs,
  (value) => localStorage.setItem('js-blitz-tabs', JSON.stringify(value)),
  { deep: true }
)
watch(activeId, (value) => localStorage.setItem('js-blitz-active-tab', value))
watch(live, (value) => localStorage.setItem('js-blitz-live', String(value)))
watch(panel, (value) => {
  localStorage.setItem('js-blitz-panel', value || '')
  if (value === 'environment' || value === 'assistant') toolsView.value = value
})

// Synchronize reused language models before the wrapper activates them.
watch(
  () => [activeTab.value.id, activeTab.value.language],
  () => {
    const monaco = monacoRef.value
    if (!monaco) return
    const tab = activeTab.value
    const uri = monaco.Uri.parse(
      'file:///workspace/' +
        tab.id +
        (tab.language === 'typescript' ? '.ts' : '.js')
    )
    const model = monaco.editor.getModel(uri)
    if (model && model.getValue() !== tab.code) model.setValue(tab.code)
  },
  { flush: 'sync' }
)
function switchTab(id: string) {
  activeId.value = id
  nextTick(() => {
    editor.value?.focus()
    updateProblems()
    tabStrip.value
      ?.querySelector('.tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function cycleTab(step: number) {
  const index = tabs.value.findIndex((t) => t.id === activeId.value)
  const next = (index + step + tabs.value.length) % tabs.value.length
  switchTab(tabs.value[next].id)
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
    void desktopAPI
      .cancelExecution(running.value[id])
      .catch((): void => undefined)
  const remaining = tabs.value.filter((tab) => tab.id !== id)
  tabs.value = remaining.length ? remaining : [createTab(1, '')]
  if (activeId.value === id)
    activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)].id
  delete outputs.value[id]
  delete errors.value[id]
  delete running.value[id]
  nextTick(() => {
    const monaco = monacoRef.value
    if (!monaco) return
    for (const extension of ['ts', 'js']) {
      const model = monaco.editor.getModel(
        monaco.Uri.parse('file:///workspace/' + id + '.' + extension)
      )
      if (model && model !== editor.value?.getModel()) model.dispose()
    }
  })
}
function startRename(id = activeId.value) {
  const tab = tabs.value.find((t) => t.id === id)
  if (!tab) return
  editingTabId.value = id
  tabNameDraft.value = tab.name
  nextTick(() => {
    const input = tabStrip.value?.querySelector<HTMLInputElement>('.tab-rename')
    input?.focus()
    input?.select()
  })
}
function commitRename() {
  const tab = tabs.value.find((t) => t.id === editingTabId.value)
  const name = tabNameDraft.value.trim().slice(0, 80)
  if (tab && name) tab.name = name
  editingTabId.value = ''
  editor.value?.focus()
}
function cancelRename() {
  editingTabId.value = ''
  editor.value?.focus()
}
function onTabWheel(event: WheelEvent) {
  if (!tabStrip.value || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  tabStrip.value.scrollLeft += event.deltaY
}
function clearOutput() {
  outputs.value[activeId.value] = []
  errors.value[activeId.value] = ''
}
async function copyOutput() {
  const text = [
    ...output.value.map((line) => line.value.join(' ')),
    errors.value[activeId.value] || '',
  ]
    .filter(Boolean)
    .join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch (error) {
    errors.value[activeId.value] =
      error instanceof Error ? error.message : String(error)
  }
}
function revealLine(line: number) {
  const instance = editor.value
  if (!instance) return
  instance.revealLineInCenterIfOutsideViewport(line)
  instance.setPosition({ lineNumber: line, column: 1 })
  instance.focus()
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
  const { KeyMod, KeyCode } = monaco
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => void executeCode())
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyT, newTab)
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyW, () =>
    closeTab(activeId.value)
  )
  instance.addCommand(
    KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP,
    () => (paletteOpen.value = true)
  )
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.KeyB, toggleSidebar)
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.Equal, () =>
    instance.trigger('zoom', 'editor.action.fontZoomIn', null)
  )
  instance.addCommand(KeyMod.CtrlCmd | KeyCode.Minus, () =>
    instance.trigger('zoom', 'editor.action.fontZoomOut', null)
  )
  const markers = monaco.editor.onDidChangeMarkers(updateProblems)
  const position = instance.onDidChangeCursorPosition((event) => {
    cursor.value = {
      line: event.position.lineNumber,
      column: event.position.column,
    }
  })
  unsubscribers.push(
    () => markers.dispose(),
    () => position.dispose()
  )
  try {
    await refreshPackageTypes(monaco)
  } catch (error) {
    packageError.value = error instanceof Error ? error.message : String(error)
  }
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
  palette.value = getUiPalette(selected.name, selected.data.colors)
  localStorage.setItem('js-blitz-ui-palette', JSON.stringify(palette.value))
}
async function executeCode() {
  const tab = activeTab.value
  const id = tab.id
  clearTimeout(liveTimer)
  const previousRun = running.value[id]
  const runId = crypto.randomUUID()
  running.value[id] = runId
  const start = performance.now()
  try {
    if (previousRun) await desktopAPI.cancelExecution(previousRun)
    if (running.value[id] !== runId) return
    outputs.value[id] = []
    errors.value[id] = ''
    const result = await desktopAPI.executeCode({
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
    try {
      await loadPackages()
      if (monacoRef.value) await refreshPackageTypes(monacoRef.value)
    } catch (error) {
      packageError.value =
        error instanceof Error ? error.message : String(error)
    }
  } catch (error) {
    if (running.value[id] === runId)
      errors.value[id] = error instanceof Error ? error.message : String(error)
  } finally {
    if (running.value[id] === runId) delete running.value[id]
  }
}
async function stopCode() {
  const runId = running.value[activeId.value]
  if (!runId) return
  try {
    await desktopAPI.cancelExecution(runId)
  } catch (error) {
    errors.value[activeId.value] =
      error instanceof Error ? error.message : String(error)
  }
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
  packages.value = await desktopAPI.listPackages()
}
async function installPackage(name: string) {
  if (!name || packageBusy.value) return
  packageBusy.value = true
  packageError.value = ''
  try {
    await desktopAPI.installPackage(name)
    packagesPanel.value?.clear()
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
async function showMoreMenu() {
  try {
    await desktopAPI.showContextMenu()
  } catch (error) {
    errors.value[activeId.value] =
      error instanceof Error ? error.message : String(error)
  }
}
function openPanel(id: Panel) {
  panel.value = id
}
function togglePanel(id: Panel) {
  panel.value = panel.value === id ? null : id
}
function toggleSidebar() {
  panel.value = panel.value
    ? null
    : (localStorage.getItem('js-blitz-last-panel') as Panel) || 'packages'
}
watch(panel, (value) => {
  if (value) localStorage.setItem('js-blitz-last-panel', value)
})
function startSidebarResize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement
  const startX = event.clientX
  const startWidth = sidebarWidth.value
  handle.setPointerCapture(event.pointerId)
  const move = (e: PointerEvent) => {
    sidebarWidth.value = Math.min(
      Math.max(startWidth + e.clientX - startX, 260),
      560
    )
  }
  const stop = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', stop)
    handle.removeEventListener('pointercancel', stop)
    localStorage.setItem('js-blitz-sidebar-width', String(sidebarWidth.value))
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
}
function pickTheme(name: string) {
  themeMenuOpen.value = false
  void setTheme(name)
}
function runEditorAction(id: string) {
  editor.value?.focus()
  void editor.value?.getAction(id)?.run()
}

const commands = computed<PaletteCommand[]>(() => [
  {
    id: 'run',
    group: 'Run',
    label: 'Run code',
    icon: 'play',
    shortcut: `${MOD}+Enter`,
    run: () => void executeCode(),
  },
  {
    id: 'stop',
    group: 'Run',
    label: 'Stop execution',
    icon: 'stop',
    disabled: !isRunning.value,
    run: () => void stopCode(),
  },
  {
    id: 'live',
    group: 'Run',
    label: live.value ? 'Turn off auto-run' : 'Turn on auto-run',
    icon: 'zap',
    run: () => (live.value = !live.value),
  },
  ...[10000, 30000, 60000].map(
    (ms): PaletteCommand => ({
      id: 'timeout-' + ms,
      group: 'Run',
      label: `Set time limit to ${ms / 1000} s`,
      icon: 'timer',
      disabled: timeoutMs.value === ms,
      run: () => (timeoutMs.value = ms),
    })
  ),
  {
    id: 'clear',
    group: 'Console',
    label: 'Clear console',
    icon: 'ban',
    run: clearOutput,
  },
  {
    id: 'copy',
    group: 'Console',
    label: 'Copy console output',
    icon: 'copy',
    run: () => void copyOutput(),
  },
  {
    id: 'new-tab',
    group: 'Tab',
    label: 'New tab',
    icon: 'plus',
    shortcut: `${MOD}+T`,
    run: newTab,
  },
  {
    id: 'close-tab',
    group: 'Tab',
    label: 'Close tab',
    icon: 'x',
    shortcut: `${MOD}+W`,
    run: () => closeTab(activeId.value),
  },
  {
    id: 'rename-tab',
    group: 'Tab',
    label: 'Rename tab',
    icon: 'pencil',
    run: () => startRename(),
  },
  {
    id: 'next-tab',
    group: 'Tab',
    label: 'Next tab',
    icon: 'chevron-right',
    shortcut: 'Ctrl+Tab',
    disabled: tabs.value.length < 2,
    run: () => cycleTab(1),
  },
  {
    id: 'export',
    group: 'Tab',
    label: `Export as .${extension.value} file`,
    icon: 'download',
    run: exportCode,
  },
  {
    id: 'language',
    group: 'Tab',
    label:
      activeTab.value.language === 'typescript'
        ? 'Switch to JavaScript'
        : 'Switch to TypeScript',
    icon: 'type',
    run: () =>
      (activeTab.value.language =
        activeTab.value.language === 'typescript'
          ? 'javascript'
          : 'typescript'),
  },
  {
    id: 'format',
    group: 'Editor',
    label: 'Format document',
    icon: 'braces',
    shortcut: 'Shift+Alt+F',
    run: () => runEditorAction('editor.action.formatDocument'),
  },
  {
    id: 'zoom-in',
    group: 'Editor',
    label: 'Zoom in',
    icon: 'plus',
    shortcut: `${MOD}+=`,
    run: () => runEditorAction('editor.action.fontZoomIn'),
  },
  {
    id: 'zoom-out',
    group: 'Editor',
    label: 'Zoom out',
    icon: 'search',
    shortcut: `${MOD}+-`,
    run: () => runEditorAction('editor.action.fontZoomOut'),
  },
  {
    id: 'sidebar',
    group: 'View',
    label: 'Toggle sidebar',
    icon: 'sidebar',
    shortcut: `${MOD}+B`,
    run: toggleSidebar,
  },
  ...PANELS.map(
    (item): PaletteCommand => ({
      id: 'panel-' + item.id,
      group: 'View',
      label: 'Open ' + item.label,
      icon: item.icon,
      run: () => openPanel(item.id),
    })
  ),
  ...themeList.value.map(
    (item): PaletteCommand => ({
      id: 'theme-' + item.name,
      group: 'Theme',
      label: item.label,
      icon: 'palette',
      disabled: theme.value === item.name,
      run: () => void setTheme(item.name),
    })
  ),
  {
    id: 'more',
    group: 'Help',
    label: 'GitHub and updates…',
    icon: 'more',
    run: () => void showMoreMenu(),
  },
])

function isTextField(target: EventTarget | null) {
  const element = target as HTMLElement | null
  return Boolean(
    element?.closest('input, textarea, select') &&
      !element.closest('.monaco-editor')
  )
}
function onGlobalKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  const key = event.key.toLowerCase()
  if (key === 'escape' && themeMenuOpen.value) {
    themeMenuOpen.value = false
    return
  }
  if (event.ctrlKey && key === 'tab') {
    event.preventDefault()
    cycleTab(event.shiftKey ? -1 : 1)
    return
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (event.shiftKey && key === 'p') {
    event.preventDefault()
    paletteOpen.value = true
  } else if (event.shiftKey) {
    return
  } else if (key === 'b') {
    event.preventDefault()
    toggleSidebar()
  } else if (key === 'enter' && !isTextField(event.target)) {
    event.preventDefault()
    void executeCode()
  } else if (key === 't') {
    event.preventDefault()
    newTab()
  } else if (key === 'w') {
    event.preventDefault()
    closeTab(activeId.value)
  }
}

onMounted(() => {
  unsubscribers.push(
    desktopAPI.on('set-theme', (name: string) => void setTheme(name))
  )
  unsubscribers.push(
    desktopAPI.on(
      'execution-output',
      (event: { runId: string; output: Output }) => {
        const id = Object.keys(running.value).find(
          (id) => running.value[id] === event.runId
        )
        if (id) (outputs.value[id] ||= []).push(event.output)
      }
    )
  )
  unsubscribers.push(
    desktopAPI.on(
      'package-installation-started',
      () => (installingPackages.value = true)
    ),
    desktopAPI.on(
      'package-installation-finished',
      () => (installingPackages.value = false)
    )
  )
  void loadPackages().catch((error) => {
    packageError.value = String(error)
  })
  void getThemes().then((themes) => {
    themeList.value = themes.map((item) => ({
      name: item.name,
      label: item.label,
      palette: getUiPalette(item.name, item.data.colors),
    }))
  })
  window.addEventListener('keydown', onGlobalKeydown)
  unsubscribers.push(() =>
    window.removeEventListener('keydown', onGlobalKeydown)
  )
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(liveTimer)
  unsubscribers.forEach((dispose) => dispose())
  Object.values(running.value).forEach(
    (id) => void desktopAPI.cancelExecution(id).catch((): void => undefined)
  )
})

const OUTPUT_ICONS: Record<Output['type'], IconName> = {
  log: 'chevron-right',
  info: 'info',
  warn: 'warning',
  error: 'error',
  result: 'arrow-left',
}
</script>

<template>
  <div class="app-shell" :style="palette">
    <TitleBar>
      <button
        class="command-center"
        :title="`Command palette (${MOD}+Shift+P)`"
        @click="paletteOpen = true"
      >
        <Icon name="search" :size="14" />
        <span class="command-center-label"
          >{{ activeTab.name || 'Untitled' }}.{{ extension }}</span
        >
        <kbd>{{ MOD }} Shift P</kbd>
      </button>
      <template #end>
        <button
          class="autorun"
          role="switch"
          :aria-checked="live"
          title="Run automatically while you type"
          @click="live = !live"
        >
          <Icon name="zap" :size="14" />
          <span class="autorun-label">Auto-run</span>
          <span class="switch" aria-hidden="true"></span>
        </button>
        <div class="run-group">
          <button
            class="run-button"
            :title="`Run code (${MOD}+Enter)`"
            @click="executeCode"
          >
            <Icon
              :name="isRunning ? 'loader' : 'play'"
              :size="14"
              :class="{ spin: isRunning }"
            />
            <span>Run</span>
            <kbd class="run-kbd">{{ MOD }} ↵</kbd>
          </button>
          <button
            class="stop-button"
            :disabled="!isRunning"
            title="Stop execution"
            aria-label="Stop execution"
            @click="stopCode"
          >
            <Icon name="stop" :size="13" />
          </button>
        </div>
      </template>
    </TitleBar>

    <div class="app-body">
      <nav class="activity-rail" aria-label="Panels">
        <button
          v-for="item in PANELS"
          :key="item.id"
          class="rail-button"
          :class="{ active: panel === item.id }"
          :aria-pressed="panel === item.id"
          :title="item.label"
          :aria-label="item.label"
          @click="togglePanel(item.id)"
        >
          <Icon :name="item.icon" :size="19" />
          <span
            v-if="item.id === 'packages' && (installingPackages || packageBusy)"
            class="rail-badge pulse"
          ></span>
        </button>
        <div class="rail-spacer"></div>
        <button
          class="rail-button"
          :class="{ active: themeMenuOpen }"
          title="Color theme"
          aria-label="Color theme"
          aria-haspopup="menu"
          :aria-expanded="themeMenuOpen"
          @click="themeMenuOpen = !themeMenuOpen"
        >
          <Icon name="palette" :size="19" />
        </button>
        <button
          class="rail-button"
          title="More (GitHub, updates)"
          aria-label="More options"
          @click="showMoreMenu"
        >
          <Icon name="more" :size="19" />
        </button>
      </nav>

      <div
        v-if="themeMenuOpen"
        class="popover-backdrop"
        @click="themeMenuOpen = false"
      ></div>
      <div
        v-if="themeMenuOpen"
        class="theme-menu"
        role="menu"
        aria-label="Color theme"
      >
        <div class="theme-menu-title">Color theme</div>
        <button
          v-for="item in themeList"
          :key="item.name"
          role="menuitemradio"
          :aria-checked="theme === item.name"
          class="theme-option"
          @click="pickTheme(item.name)"
        >
          <span
            class="theme-swatch"
            :style="{ background: item.palette['--ui-bg'] }"
          >
            <span :style="{ background: item.palette['--ui-accent'] }"></span>
            <span :style="{ background: item.palette['--ui-success'] }"></span>
            <span :style="{ background: item.palette['--ui-danger'] }"></span>
          </span>
          <span class="theme-name">{{ item.label }}</span>
          <Icon v-if="theme === item.name" name="check" :size="14" />
        </button>
      </div>

      <aside
        v-show="panel"
        class="sidebar"
        :style="{ width: sidebarWidth + 'px' }"
        :aria-label="PANELS.find((p) => p.id === panel)?.label"
      >
        <header class="sidebar-header">
          <h2>{{ PANELS.find((p) => p.id === panel)?.label }}</h2>
          <button
            v-if="panel === 'snippets'"
            class="icon-btn"
            title="Save editor code as snippet"
            aria-label="Save editor code as snippet"
            @click="snippetLibrary?.create()"
          >
            <Icon name="plus" :size="15" />
          </button>
          <button
            class="icon-btn"
            :title="`Close sidebar (${MOD}+B)`"
            aria-label="Close sidebar"
            @click="panel = null"
          >
            <Icon name="x" :size="15" />
          </button>
        </header>
        <div class="sidebar-body">
          <PackagesPanel
            v-show="panel === 'packages'"
            ref="packagesPanel"
            :packages="packages"
            :busy="packageBusy"
            :error="packageError"
            @install="installPackage"
          />
          <SnippetLibrary
            v-show="panel === 'snippets'"
            ref="snippetLibrary"
            :code="code"
            @insert="insertSnippet"
            @new-tab="snippetInNewTab"
          />
          <DesktopTools
            v-show="panel === 'environment' || panel === 'assistant'"
            :view="toolsView"
            :code="code"
            @insert-code="insertCode"
          />
        </div>
        <div
          class="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          @pointerdown.prevent="startSidebarResize"
        ></div>
      </aside>

      <main class="workspace">
        <Splitpanes class="code-panes">
          <Pane :min-size="20" :size="58">
            <section class="editor-pane">
              <div class="tab-bar">
                <div
                  ref="tabStrip"
                  class="tab-strip"
                  role="tablist"
                  aria-label="Code tabs"
                  @wheel.passive="onTabWheel"
                >
                  <div
                    v-for="tab in tabs"
                    :key="tab.id"
                    class="tab"
                    :class="{ active: tab.id === activeId }"
                    @auxclick.prevent="
                      ($event as MouseEvent).button === 1 && closeTab(tab.id)
                    "
                  >
                    <span
                      class="lang-badge"
                      :class="tab.language"
                      aria-hidden="true"
                      >{{ tab.language === 'typescript' ? 'TS' : 'JS' }}</span
                    >
                    <input
                      v-if="editingTabId === tab.id"
                      v-model="tabNameDraft"
                      class="tab-rename"
                      maxlength="80"
                      aria-label="Tab name"
                      @keydown.enter.prevent="commitRename"
                      @keydown.escape.prevent="cancelRename"
                      @blur="commitRename"
                    />
                    <button
                      v-else
                      :id="'tab-' + tab.id"
                      class="tab-label"
                      role="tab"
                      :aria-selected="tab.id === activeId"
                      title="Double-click to rename"
                      @click="switchTab(tab.id)"
                      @dblclick="startRename(tab.id)"
                    >
                      {{ tab.name || 'Untitled' }}
                    </button>
                    <span
                      v-if="running[tab.id]"
                      class="tab-running"
                      aria-label="Running"
                    ></span>
                    <button
                      class="tab-close"
                      :aria-label="'Close ' + tab.name"
                      :title="`Close (${MOD}+W)`"
                      @click="closeTab(tab.id)"
                    >
                      <Icon name="x" :size="13" />
                    </button>
                  </div>
                </div>
                <button
                  class="icon-btn"
                  :title="`New tab (${MOD}+T)`"
                  aria-label="New tab"
                  @click="newTab"
                >
                  <Icon name="plus" :size="16" />
                </button>
                <div class="tab-bar-spacer"></div>
                <button
                  class="icon-btn"
                  :title="`Export as .${extension}`"
                  aria-label="Export code"
                  @click="exportCode"
                >
                  <Icon name="download" :size="15" />
                </button>
              </div>
              <div
                class="editor-host"
                role="tabpanel"
                :aria-labelledby="'tab-' + activeId"
              >
                <VueMonacoEditor
                  v-model:value="code"
                  :path="'file:///workspace/' + activeId + '.' + extension"
                  :language="activeTab.language"
                  :theme="theme"
                  :keep-current-model="true"
                  :options="{
                    automaticLayout: true,
                    minimap: { enabled: false },
                    fontSize: 14,
                    lineHeight: 22,
                    fontFamily: `'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace`,
                    fontLigatures: true,
                    tabSize: 2,
                    padding: { top: 14, bottom: 14 },
                    scrollBeyondLastLine: false,
                    formatOnPaste: true,
                    suggestOnTriggerCharacters: true,
                    smoothScrolling: true,
                    cursorBlinking: 'smooth',
                    cursorSmoothCaretAnimation: 'on',
                    renderLineHighlight: 'all',
                    roundedSelection: true,
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: 'active', indentation: true },
                    overviewRulerBorder: false,
                    hideCursorInOverviewRuler: true,
                    lineNumbersMinChars: 3,
                    scrollbar: {
                      verticalScrollbarSize: 10,
                      horizontalScrollbarSize: 10,
                      useShadows: false,
                    },
                    stickyScroll: { enabled: false },
                  }"
                  @mount="mountEditor"
                />
              </div>
            </section>
          </Pane>
          <Pane :min-size="15" :size="42">
            <section class="output-pane" aria-label="Console">
              <div class="pane-header">
                <Icon name="terminal" :size="15" />
                <span class="pane-title">Console</span>
                <span v-if="output.length" class="count">{{
                  output.length
                }}</span>
                <div class="tab-bar-spacer"></div>
                <button
                  class="icon-btn"
                  :title="copied ? 'Copied' : 'Copy output'"
                  aria-label="Copy output"
                  :disabled="!output.length && !errors[activeId]"
                  @click="copyOutput"
                >
                  <Icon :name="copied ? 'check' : 'copy'" :size="15" />
                </button>
                <button
                  class="icon-btn"
                  title="Clear console"
                  aria-label="Clear console"
                  @click="clearOutput"
                >
                  <Icon name="ban" :size="15" />
                </button>
              </div>
              <div v-if="isRunning" class="progress" aria-hidden="true"></div>
              <div class="console" role="log" aria-label="Execution output">
                <div
                  v-if="!output.length && !errors[activeId]"
                  class="console-empty"
                >
                  <div class="console-empty-icon">
                    <Icon name="terminal" :size="22" />
                  </div>
                  <strong>{{
                    isRunning ? 'Running…' : 'Ready when you are'
                  }}</strong>
                  <p>
                    Press <kbd>{{ MOD }}</kbd> <kbd>Enter</kbd> to run.
                    <template v-if="live"
                      ><br />Auto-run is on — results update as you
                      type.</template
                    >
                  </p>
                  <p class="console-empty-hint">
                    Expressions, <code>console</code> output and errors appear
                    here, next to their line.
                  </p>
                </div>
                <div
                  v-for="(line, index) in output"
                  :key="index"
                  class="log-row"
                  :class="'log-' + line.type"
                >
                  <span class="log-icon"
                    ><Icon :name="OUTPUT_ICONS[line.type]" :size="13"
                  /></span>
                  <pre class="log-text">{{ line.value.join(' ') }}</pre>
                  <button
                    v-if="line.line"
                    class="log-line"
                    :title="`Go to line ${line.line}`"
                    @click="revealLine(line.line)"
                  >
                    :{{ line.line }}
                  </button>
                </div>
                <div
                  v-if="errors[activeId]"
                  class="execution-error"
                  role="alert"
                >
                  <div class="execution-error-title">
                    <Icon name="error" :size="14" /> Execution failed
                  </div>
                  <pre>{{ errors[activeId] }}</pre>
                </div>
              </div>
            </section>
          </Pane>
        </Splitpanes>
      </main>
    </div>

    <footer class="status-bar">
      <span class="status-item status-run" :class="'state-' + runState">
        <span class="status-dot"></span>
        {{
          runState === 'running'
            ? 'Running…'
            : runState === 'error'
              ? 'Failed'
              : runState === 'success'
                ? 'Done'
                : 'Ready'
        }}
        <span v-if="runState !== 'running' && duration[activeId] !== undefined"
          >· {{ duration[activeId] }} ms</span
        >
      </span>
      <button
        class="status-item status-button"
        title="Go to next problem"
        @click="runEditorAction('editor.action.marker.next')"
      >
        <Icon name="error" :size="12" />{{ problemCounts.errors }}
        <Icon name="warning" :size="12" />{{ problemCounts.warnings }}
      </button>
      <span v-if="installingPackages" class="status-item status-install">
        <Icon name="loader" :size="12" class="spin" /> Installing packages…
      </span>
      <span class="status-spacer"></span>
      <span class="status-item"
        >Ln {{ cursor.line }}, Col {{ cursor.column }}</span
      >
      <label class="status-item status-button">
        <Icon name="timer" :size="12" />
        <select v-model="timeoutMs" aria-label="Execution time limit">
          <option :value="10000">10 s</option>
          <option :value="30000">30 s</option>
          <option :value="60000">60 s</option>
        </select>
      </label>
      <label class="status-item status-button">
        <select v-model="activeTab.language" aria-label="Language">
          <option value="typescript">TypeScript</option>
          <option value="javascript">JavaScript</option>
        </select>
      </label>
      <span class="status-item">Node.js</span>
    </footer>

    <CommandPalette
      v-if="paletteOpen"
      :commands="commands"
      @close="paletteOpen = false"
    />
  </div>
</template>

<style>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.spin {
  animation: spin 0.8s linear infinite;
}
.pulse {
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

/* Title bar content */
.command-center {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 420px;
  height: 28px;
  padding: 0 6px 0 10px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-hover);
  color: var(--ui-muted);
  transition:
    background-color 0.12s,
    border-color 0.12s;
}
.command-center:hover {
  border-color: var(--ui-border-strong);
  background: var(--ui-active);
  color: var(--ui-fg);
}
.command-center-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: 12px;
}
.autorun {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--ui-muted);
  font-size: 12px;
  white-space: nowrap;
}
.autorun:hover {
  background: var(--ui-hover);
  color: var(--ui-fg);
}
.autorun[aria-checked='true'] > svg {
  color: var(--ui-warn);
}
.switch {
  position: relative;
  width: 26px;
  height: 15px;
  border-radius: 999px;
  background: var(--ui-border-strong);
  transition: background-color 0.15s;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--ui-fg);
  transition: transform 0.15s;
}
.autorun[aria-checked='true'] .switch {
  background: var(--ui-accent);
}
.autorun[aria-checked='true'] .switch::after {
  background: var(--ui-accent-fg);
  transform: translateX(11px);
}
.run-group {
  display: flex;
  height: 28px;
  border-radius: 8px;
  box-shadow: 0 1px 8px -2px color-mix(in srgb, var(--ui-accent) 50%, transparent);
}
.run-button,
.stop-button {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  background: var(--ui-accent);
  color: var(--ui-accent-fg) !important;
  font-weight: 600;
  transition: background-color 0.12s;
}
.run-button {
  padding: 0 8px 0 10px;
  border-radius: 8px 0 0 8px;
}
.stop-button {
  justify-content: center;
  width: 28px;
  border-left: 1px solid
    color-mix(in srgb, var(--ui-accent-fg) 20%, transparent);
  border-radius: 0 8px 8px 0;
}
.run-button:hover,
.stop-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 85%, #fff);
}
.stop-button:disabled {
  opacity: 1;
  color: color-mix(in srgb, var(--ui-accent-fg) 40%, transparent) !important;
  cursor: default;
}
.stop-button:not(:disabled) {
  background: var(--ui-danger);
  color: #fff !important;
}
.run-kbd {
  height: 16px;
  border: 0;
  background: color-mix(in srgb, var(--ui-accent-fg) 14%, transparent);
  color: inherit;
  opacity: 0.8;
}

/* Body layout */
.app-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.activity-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 48px;
  flex-shrink: 0;
  padding: 8px 0;
  background: var(--ui-chrome);
  border-right: 1px solid var(--ui-border);
}
.rail-spacer {
  flex: 1;
}
.rail-button {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  color: var(--ui-subtle);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.rail-button:hover {
  background: var(--ui-hover);
  color: var(--ui-fg);
}
.rail-button.active {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.rail-button.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--ui-accent);
}
.rail-badge {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ui-warn);
  box-shadow: 0 0 0 2px var(--ui-chrome);
}
.popover-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
}
.theme-menu {
  position: absolute;
  left: 54px;
  bottom: 44px;
  z-index: 31;
  width: 230px;
  padding: 6px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 12px;
  background: var(--ui-popover);
  box-shadow: 0 16px 48px -8px #000a;
  animation: menu-in 0.12s ease-out;
}
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
.theme-menu-title {
  padding: 6px 8px 8px;
  color: var(--ui-subtle);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.theme-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: left;
}
.theme-option:hover {
  background: var(--ui-hover);
}
.theme-option[aria-checked='true'] {
  color: var(--ui-accent);
}
.theme-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 38px;
  height: 22px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 6px;
}
.theme-swatch span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.theme-name {
  flex: 1;
}

/* Sidebar */
.sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  background: var(--ui-sidebar);
  border-right: 1px solid var(--ui-border);
}
.sidebar-header {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  flex-shrink: 0;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--ui-border);
}
.sidebar-header h2 {
  flex: 1;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-muted);
}
.sidebar-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.sidebar-body > .desktop-tools {
  height: 100%;
}
.sidebar-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  z-index: 5;
  width: 6px;
  cursor: col-resize;
}
.sidebar-resizer:hover,
.sidebar-resizer:active {
  background: linear-gradient(
    to right,
    transparent 2px,
    var(--ui-accent) 2px,
    var(--ui-accent) 4px,
    transparent 4px
  );
}

/* Workspace */
.workspace {
  display: flex;
  flex: 1;
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
  position: relative;
  flex-shrink: 0;
  background: var(--ui-border);
}
.splitpanes--vertical > .splitpanes__splitter {
  width: 1px;
  cursor: col-resize;
}
.splitpanes__splitter::before {
  content: '';
  position: absolute;
  inset: 0 -3px;
  z-index: 2;
  transition: background-color 0.15s;
}
.splitpanes__splitter:hover::before {
  background: color-mix(in srgb, var(--ui-accent) 70%, transparent);
}
.editor-pane,
.output-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.editor-host {
  position: relative;
  flex: 1;
  min-height: 0;
}
/* The Monaco wrapper sets inline position/size; pin it to the host instead. */
.editor-host > div {
  position: absolute !important;
  inset: 0;
}
.tab-bar,
.pane-header {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  flex-shrink: 0;
  padding: 0 8px 0 6px;
  background: var(--ui-sidebar);
  border-bottom: 1px solid var(--ui-border);
}
.tab-bar-spacer {
  flex: 1;
}
.tab-strip {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.tab-strip::-webkit-scrollbar {
  display: none;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  height: 30px;
  max-width: 220px;
  padding: 0 4px 0 10px;
  border-radius: 7px;
  color: var(--ui-subtle);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.tab:hover {
  background: var(--ui-hover);
  color: var(--ui-muted);
}
.tab.active {
  background: var(--ui-bg);
  color: var(--ui-fg);
  box-shadow:
    0 0 0 1px var(--ui-border),
    0 1px 3px #0003;
}
.lang-badge {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 18px;
  height: 14px;
  border-radius: 3px;
  font: 700 8.5px/1 var(--font-sans);
  letter-spacing: 0.02em;
  opacity: 0.85;
}
.lang-badge.typescript {
  background: #3178c6;
  color: #fff;
}
.lang-badge.javascript {
  background: #f7df1e;
  color: #1a1a1a;
}
.tab.active .lang-badge {
  opacity: 1;
}
.tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
}
.tab-label:focus-visible {
  outline: none;
  text-decoration: underline;
}
.tab-rename {
  width: 120px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--ui-accent);
  border-radius: 5px;
  outline: none;
  background: var(--ui-input);
  font-size: 12.5px;
}
.tab-running {
  flex-shrink: 0;
  width: 10px;
  height: 10px;
  border: 2px solid var(--ui-accent);
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.tab-close {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  color: var(--ui-subtle);
  opacity: 0;
}
.tab:hover .tab-close,
.tab.active .tab-close,
.tab-close:focus-visible {
  opacity: 1;
}
.tab-close:hover {
  background: var(--ui-active);
  color: var(--ui-fg);
}

/* Console */
.output-pane {
  position: relative;
  background: color-mix(in srgb, var(--ui-bg) 94%, #000);
}
.pane-header {
  gap: 8px;
  padding-left: 14px;
  color: var(--ui-muted);
}
.pane-title {
  color: var(--ui-fg);
  font-size: 12.5px;
  font-weight: 600;
}
.progress {
  position: absolute;
  top: 39px;
  left: 0;
  right: 0;
  z-index: 2;
  height: 2px;
  overflow: hidden;
  opacity: 0;
  animation: appear 0s 0.25s forwards;
}
.progress::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  background: linear-gradient(
    90deg,
    transparent,
    var(--ui-accent),
    transparent
  );
  animation: indeterminate 1.1s ease-in-out infinite;
}
@keyframes appear {
  to {
    opacity: 1;
  }
}
@keyframes indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
  }
}
.console {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 0 16px;
  font: 13px/1.6 var(--font-mono);
}
.console-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  min-height: 200px;
  padding: 24px;
  color: var(--ui-muted);
  text-align: center;
  font-family: var(--font-sans);
  line-height: 1.7;
}
.console-empty-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin-bottom: 4px;
  border: 1px solid var(--ui-border);
  border-radius: 14px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.console-empty strong {
  color: var(--ui-fg);
  font-size: 14px;
  font-weight: 600;
}
.console-empty p {
  margin: 0;
}
.console-empty-hint {
  max-width: 280px;
  color: var(--ui-subtle);
  font-size: 12px;
}
.console-empty code {
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.log-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 12px 3px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-fg) 4%, transparent);
  border-left: 2px solid transparent;
}
.log-row:hover {
  background: var(--ui-hover);
}
.log-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  height: 20.8px;
  color: var(--ui-subtle);
}
.log-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.log-line {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  color: var(--ui-subtle);
  font: 11px/20.8px var(--font-mono);
}
.log-line:hover {
  background: var(--ui-active);
  color: var(--ui-accent);
}
.log-result .log-text,
.log-result .log-icon {
  color: var(--ui-accent);
}
.log-info .log-text,
.log-info .log-icon {
  color: var(--ui-info);
}
.log-warn {
  border-left-color: var(--ui-warn);
  background: color-mix(in srgb, var(--ui-warn) 7%, transparent);
}
.log-warn .log-text,
.log-warn .log-icon {
  color: var(--ui-warn);
}
.log-error {
  border-left-color: var(--ui-danger);
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
}
.log-error .log-text,
.log-error .log-icon {
  color: var(--ui-danger);
}
.execution-error {
  margin: 10px 12px 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ui-danger) 35%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ui-danger) 8%, transparent);
}
.execution-error-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--ui-danger) 20%, transparent);
  color: var(--ui-danger);
  font: 600 12px var(--font-sans);
}
.execution-error pre {
  margin: 0;
  padding: 10px 12px;
  color: color-mix(in srgb, var(--ui-danger) 75%, var(--ui-fg));
  font: 12.5px/1.6 var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Status bar */
.status-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  flex-shrink: 0;
  padding: 0 8px;
  background: var(--ui-chrome);
  border-top: 1px solid var(--ui-border);
  color: var(--ui-subtle);
  font-size: 11.5px;
  white-space: nowrap;
}
.status-spacer {
  flex: 1;
}
.status-item {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 7px;
  border-radius: 5px;
}
.status-button {
  cursor: pointer;
}
.status-button:hover {
  background: var(--ui-hover);
  color: var(--ui-fg);
}
.status-button > svg + svg {
  margin-left: 4px;
}
.status-bar select {
  appearance: none;
  border: 0;
  outline: none;
  background: transparent;
  cursor: pointer;
}
.status-bar select option {
  background: var(--ui-popover);
  color: var(--ui-fg);
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ui-subtle);
}
.state-success .status-dot {
  background: var(--ui-success);
}
.state-error {
  color: var(--ui-danger);
}
.state-error .status-dot {
  background: var(--ui-danger);
}
.state-running {
  color: var(--ui-accent);
}
.state-running .status-dot {
  background: var(--ui-accent);
  animation: pulse 1s ease-in-out infinite;
}
.status-install {
  color: var(--ui-warn);
}

@media (max-width: 760px) {
  .sidebar {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 48px;
    z-index: 20;
    max-width: calc(100% - 64px);
    box-shadow: 12px 0 32px -8px #000a;
  }
  .autorun-label,
  .run-kbd,
  .command-center kbd {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .app-shell *,
  .app-shell *::before,
  .app-shell *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
