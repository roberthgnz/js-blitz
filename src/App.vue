<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useMonaco, type EditorProps } from '@guolao/vue-monaco-editor'
import { useElementSize, useStorage } from '@vueuse/core'
// @ts-ignore
import { Pane, Splitpanes } from 'splitpanes'

import ActivityBar from './components/ActivityBar.vue'
import LoadingIcon from './components/icons/Loading.vue'
import TitleBar from './components/TitleBar.vue'
import { downloadCode } from './lib/download'
import { getThemes } from './lib/themes'

const MONACO_EDITOR_OPTIONS: EditorProps['options'] = {
  automaticLayout: true,
  formatOnType: true,
  formatOnPaste: true,
  lineNumbers: 'off',
  minimap: {
    enabled: false,
  },
  stickyScroll: {
    enabled: false,
  },
}

const DEFAULT_CODE =
  '// Write your TypeScript/JavaScript code here\nconsole.log("Hello World!");'

const inputCodeStorage = useStorage(
  'js-blitz-input-code',
  DEFAULT_CODE,
  localStorage,
  {
    listenToStorageChanges: false,
  }
)

const code = ref(inputCodeStorage.value || DEFAULT_CODE)
const editorRef = shallowRef()

const { monacoRef } = useMonaco()

const themeColorStorage = useStorage(
  'js-blitz-theme',
  'dracula',
  localStorage,
  {
    listenToStorageChanges: false,
  }
)

const themes = ref([])

const getThemeColor = (color: string) => {
  return themes.value.find((theme) => theme.name === themeColorStorage.value)
    ?.data.colors[color]
}

const editorBgColor = computed(() => {
  return getThemeColor('editor.background')
})
const editorFgColor = computed(() => {
  return getThemeColor('editor.foreground')
})
const activityBarBackground = computed(() => {
  return getThemeColor('activityBar.background')
})
const activityBarForeground = computed(() => {
  return getThemeColor('activityBar.foreground')
})

const handleMount = async (editor: any) => {
  editorRef.value = editor

  /**
   * LISTENERS
   */
  editorRef.value?.onDidChangeModelContent(() => {
    inputCodeStorage.value = editorRef.value?.getValue() || ''
  })

  /**
   * THEMES
   */
  themes.value = await getThemes()

  themes.value.forEach((theme) => {
    monacoRef.value.editor.defineTheme(theme.name, theme.data)
  })

  monacoRef.value.editor.setTheme(themeColorStorage.value)
}

const outputElement = ref<HTMLElement | null>(null)

watch(
  () => [monacoRef.value, editorRef.value],
  ([monaco, editor]) => {
    if (!monaco || !editor) return
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, executeCode)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.US_EQUAL, () => {
      editor.trigger('zoom', 'editor.action.fontZoomIn')
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.US_MINUS, () => {
      editor.trigger('zoom', 'editor.action.fontZoomOut')
    })
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      diagnosticCodesToIgnore: [2792], // Disable the "Cannot find module" error messages
    })
  },
  { immediate: true, deep: true }
)

const isExecutingCode = ref(false)

const executeCode = async () => {
  try {
    const uri = editorRef.value.getModel().uri
    const worker =
      await monacoRef.value.languages.typescript.getTypeScriptWorker()
    const workerInstance = await worker(uri)
    const result = await workerInstance.getEmitOutput(uri.toString())
    const jsCode = result.outputFiles[0].text
    runCode(jsCode)
  } catch (error) {
    console.log(`Error: ${error.message}`)
  }
}

const parseConsoleValue = (args: any[]) => {
  return args.map((arg) => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2)
      } catch (e) {
        return '[Circular]'
      }
    }
    return String(arg)
  })
}

const printOutput = (output: any[]) => {
  output.forEach((line: any) => {
    const formattedOutput = parseConsoleValue(line.value).join(' ') + '\n'
    outputElement.value.innerHTML += `<span class="line" data-${line.type}-method>${formattedOutput}</span>`
  })
}

const runCode = async (code: string) => {
  console.time('runCode')
  try {
    clearOutput()
    const result = await window.electronAPI.executeCode(code)
    if (result.error) {
      throw new Error(result.error)
    }
    printOutput(result.output)
  } catch (error) {
    isExecutingCode.value = false
    console.log(`Error: ${error.message}`)
  } finally {
    console.timeEnd('runCode')
  }
}

const clearOutput = () => (outputElement.value.innerHTML = '')

const showContextMenu = () => {
  window.electronAPI.showContextMenu()
}

const topBar = ref<HTMLElement | null>(null)

const { height: v } = useElementSize(topBar, undefined, { box: 'border-box' })

const height = computed(() => `${v.value}px`)

const panelSizesStorage = useStorage(
  'js-blitz-panel-sizes',
  [60, 40],
  localStorage,
  {
    listenToStorageChanges: false,
  }
)

const handleResize = (event: any[]) => {
  panelSizesStorage.value = event.map(({ size }) => size)
}

watch(
  editorBgColor,
  (color) => {
    if (!color) return
    // Set background color
    localStorage.setItem('js-blitz-bg-color', color)
  },
  { immediate: true }
)

onMounted(() => {
  window.electronAPI.on('set-theme', async (theme: string) => {
    themeColorStorage.value = theme
    monacoRef.value.editor.setTheme(theme)
  })

  window.electronAPI.on('package-installation-started', () => {
    isExecutingCode.value = true
  })

  window.electronAPI.on('package-installation-finished', () => {
    isExecutingCode.value = false
  })

  window.electronAPI.on('code-execution-started', () => {
    isExecutingCode.value = true
  })

  window.electronAPI.on('code-execution-finished', () => {
    isExecutingCode.value = false
  })
})
</script>

<template>
  <TitleBar
    ref="topBar"
    :style="{
      backgroundColor: activityBarBackground,
      '--buttonForeground': activityBarForeground,
      '--buttonHoverForeground': activityBarForeground,
    }"
  />
  <div
    class="relative size-full grid grid-cols-[32px_auto]"
    :style="{
      height: `calc(100% - ${height})`,
    }"
  >
    <ActivityBar
      @run-code="executeCode"
      @clear-output="clearOutput"
      @download-code="() => downloadCode(code)"
      @show-context-menu="showContextMenu"
      :style="{
        height: `calc(100% - ${height})`,
        backgroundColor: activityBarBackground,
      }"
    />
    <Splitpanes @resize="handleResize">
      <Pane :min-size="10" :size="panelSizesStorage[0]">
        <div class="scrolls">
          <VueMonacoEditor
            v-model:value="code"
            theme="dracula"
            language="typescript"
            :options="MONACO_EDITOR_OPTIONS"
            @mount="handleMount"
          />
        </div>
      </Pane>
      <Pane :min-size="10" :size="panelSizesStorage[1]">
        <div class="scrolls">
          <LoadingIcon
            v-if="isExecutingCode"
            class="absolute top-[14px] left-[14px] size-4 animate-spin"
            :style="{
              color: activityBarForeground,
            }"
          />
          <pre ref="outputElement" class="output"></pre>
        </div>
      </Pane>
    </Splitpanes>
  </div>
</template>

<style>
.splitpanes {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
}

.splitpanes.loading .splitpanes__pane {
  transition: none !important;
}

.splitpanes__pane {
  position: relative;
  inset: 0;
  height: 100%;
}

.splitpanes__splitter {
  width: 5px;
  height: 100vh;
  background: #444;
  cursor: col-resize;
}

.scrolls {
  position: relative;
  height: 100%;
  overflow: auto;
}

.output {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  color: v-bind(editorFgColor);
  background-color: v-bind(editorBgColor);
  font-family: 'Consolas', monospace;
  white-space: pre-wrap;
  font-size: 14px;
  padding: 0 14px;
}

.output .line {
  display: block;
  min-height: 19px;
}

[data-log-method] {
  color: #0f0;
}

[data-info-method] {
  color: #0ff;
}

[data-warn-method] {
  color: #ff0;
}

[data-error-method] {
  color: #f00;
}

button {
  opacity: 0.75;
  color: v-bind(activityBarForeground);
  transition: all0.2s;
}

button:hover {
  opacity: 1;
  color: v-bind(activityBarForeground);
}

::-webkit-scrollbar {
  width: 2px;
  height: 2px;
}

::-webkit-scrollbar-track {
  background: #222;
}

::-webkit-scrollbar-thumb {
  background: #444;
}

:hover::-webkit-scrollbar-thumb {
  background: #666;
}
</style>
