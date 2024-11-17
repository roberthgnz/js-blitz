<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useMonaco, type EditorProps } from '@guolao/vue-monaco-editor'
import { useElementSize, useStorage } from '@vueuse/core'
// @ts-ignore
import { Pane, Splitpanes } from 'splitpanes'

import DraculaTheme from '../vs-themes/dracula.json'
import ClearIcon from './components/icons/Clear.vue'
import LoadingIcon from './components/icons/Loading.vue'
import RunIcon from './components/icons/Run.vue'
import SettingsIcon from './components/icons/Settings.vue'
import WindowControls from './components/WindowControls.vue'
import { getPackages } from './lib/packages'

const MONACO_EDITOR_OPTIONS: EditorProps['options'] = {
  automaticLayout: true,
  formatOnType: true,
  formatOnPaste: true,
  minimap: {
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

const getThemeColor = (color: string) => {
  return editorRef.value?._themeService._theme.themeData.colors[color]
}

const editorBgColor = computed(() => {
  return getThemeColor('editor.background')
})
const editorFgColor = computed(() => {
  return getThemeColor('editor.foreground')
})
const statusBarBackground = computed(() => {
  return getThemeColor('statusBar.background')
})
const statusBarForeground = computed(() => {
  return getThemeColor('statusBar.foreground')
})
const buttonSecondaryForeground = computed(() => {
  return getThemeColor('button.secondaryForeground')
})
const buttonSecondaryHoverBackground = computed(() => {
  return getThemeColor('button.secondaryHoverBackground')
})

const { monacoRef } = useMonaco()

const getMonacoThemeData = (themeDefinition: any) => {
  const themeData: any = {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: themeDefinition.colors,
  }

  // Map token colors
  themeDefinition.tokenColors.forEach((tokenColor: any) => {
    const rule = {
      token: tokenColor.scope.join(', '),
      foreground: tokenColor.settings.foreground,
      background: tokenColor.settings.background,
      fontStyle: tokenColor.settings.fontStyle,
    }
    themeData.rules.push(rule)
  })

  return themeData
}

const handleMount = (editor: any) => {
  editorRef.value = editor

  /**
   * LISTENERS
   */
  editorRef.value?.onDidChangeModelContent(() => {
    inputCodeStorage.value = editorRef.value?.getValue() || ''
  })

  /**
   * THEME CONFIGURATION
   */
  monacoRef.value.editor.defineTheme(
    'dracula',
    getMonacoThemeData(DraculaTheme)
  )
  monacoRef.value.editor.setTheme('dracula')
}

const outputElement = ref<HTMLElement | null>(null)

const originalConsole = { ...console }

console.log = function (...args) {
  originalConsole.log(...args)

  if (!outputElement.value || !(outputElement.value instanceof HTMLElement))
    return

  const formattedOutput =
    args
      .map((arg) => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2)
          } catch (e) {
            return '[Circular]'
          }
        }
        return String(arg)
      })
      .join(' ') + '\n'

  outputElement.value.innerHTML += formattedOutput
}

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
  },
  { immediate: true, deep: true }
)

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

const runCode = async (code: string) => {
  console.time('runCode')
  try {
    clearOutput()

    const packages = getPackages(code)

    if (!packages.length) {
      return eval(code)
    }

    const result = await window.electronAPI.executeCode({
      code,
      packages,
    })
    if (result.error) {
      throw new Error(result.error)
    }
    console.log(result.output)
  } catch (error) {
    console.log(`Error: ${error.message}`)
  } finally {
    console.timeEnd('runCode')
    monacoRef.value.editor.colorizeElement(outputElement.value, {
      theme: 'dracula',
    })
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

const isExecutingCode = ref(false)

onMounted(() => {
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
  <WindowControls
    ref="topBar"
    :style="{
      backgroundColor: statusBarBackground,
      '--buttonSecondaryForeground': buttonSecondaryForeground,
      '--buttonSecondaryHoverBackground': buttonSecondaryHoverBackground,
    }"
  />
  <div
    class="relative size-full grid grid-cols-[32px_auto]"
    :style="{
      height: `calc(100% - ${height})`,
    }"
  >
    <div
      class="size-full flex flex-col items-center"
      :style="{
        height: `calc(100% - ${height})`,
        backgroundColor: statusBarBackground,
      }"
    >
      <button
        type="button"
        class="p-2 select-none"
        title="Run code (CtrlCmd + Enter)"
        @click="executeCode"
      >
        <RunIcon class="size-4" />
      </button>
      <button
        type="button"
        class="p-2 select-none"
        title="Clear output"
        @click="clearOutput"
      >
        <ClearIcon class="size-4" />
      </button>
      <button
        type="button"
        class="p-2 select-none mt-auto"
        title="Settings"
        @click="showContextMenu"
      >
        <SettingsIcon class="size-4" />
      </button>
    </div>
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
            class="absolute top-[14px] right-[14px] size-4 animate-spin"
            :style="{
              color: statusBarForeground,
            }"
          />
          <pre
            ref="outputElement"
            class="output"
            data-lang="text/typescript"
          ></pre>
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

button {
  color: v-bind(statusBarForeground);
  transition: background-color 0.2s;
}

button:hover {
  color: v-bind(statusBarForeground);
  background-color: v-bind(buttonSecondaryHoverBackground);
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
