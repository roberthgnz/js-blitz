<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useMonaco, type EditorProps } from '@guolao/vue-monaco-editor'
import { useElementSize, useStorage } from '@vueuse/core'
import { ipcRenderer } from 'electron'
// @ts-ignore
import { Pane, Splitpanes } from 'splitpanes'

import { getPackages } from '../lib/packages'
import DraculaTheme from '../vs-themes/dracula.json'
import ClearIcon from './components/icons/Clear.vue'
import RunIcon from './components/icons/Run.vue'

const MONACO_EDITOR_OPTIONS: EditorProps['options'] = {
  theme: 'vs-dark',
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
const tabHoverBackground = computed(() => {
  return getThemeColor('tab.hoverBackground')
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
   * COMMANDS SETUP
   */
  editorRef.value.addCommand(
    monacoRef.value.KeyMod.CtrlCmd | monacoRef.value.KeyCode.Enter,
    executeCode
  )

  /**
   * LISTENERS
   */
  editorRef.value?.onDidChangeModelContent(() => {
    inputCodeStorage.value = editorRef.value?.getValue() || ''
  })

  /**
   * LANGUAGE CONFIGURATION
   */
  monacoRef.value.languages.typescript.typescriptDefaults.setCompilerOptions({
    noImplicitAny: false,
    allowJs: true,
    skipLibCheck: true,
    target: monacoRef.value.languages.typescript.ScriptTarget.ESNext,
    module: monacoRef.value.languages.typescript.ModuleKind.ESNext,
    moduleResolution:
      monacoRef.value.languages.typescript.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    inlineSourceMap: true,
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

const outputElement = ref(null)

const originalConsole = { ...console }

console.log = function (...args) {
  originalConsole.log(...args)
  if (!outputElement.value) return
  outputElement.value.innerHTML +=
    args
      .map((arg) => {
        if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 2)
        }
        return String(arg)
      })
      .join(' ') + '\n'
}

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
  }
}

const clearOutput = () => (outputElement.value.innerHTML = '')

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
</script>

<template>
  <Splitpanes @resize="handleResize">
    <Pane :min-size="10" :size="panelSizesStorage[0]">
      <div
        ref="topBar"
        class="flex items-center justify-end"
        :style="{ backgroundColor: statusBarBackground }"
      >
        <button
          type="button"
          class="p-1 select-none"
          title="Run code (CtrlCmd + Enter)"
          @click="executeCode"
        >
          <RunIcon class="size-4" />
        </button>
      </div>
      <div class="scrolls">
        <VueMonacoEditor
          v-model:value="code"
          default-language="typescript"
          :options="MONACO_EDITOR_OPTIONS"
          @mount="handleMount"
        >
          <template>
            <div class="size-full grid place-content-center text-4xl">
              Cargo.toml
            </div>
          </template>
        </VueMonacoEditor>
      </div>
    </Pane>
    <Pane :min-size="10" :size="panelSizesStorage[1]">
      <div
        class="flex items-center justify-end"
        :style="{ backgroundColor: statusBarBackground }"
      >
        <button
          type="button"
          class="p-1 select-none"
          title="Clear output"
          @click="clearOutput"
        >
          <ClearIcon class="size-4" />
        </button>
      </div>
      <div class="scrolls">
        <div ref="outputElement" class="output"></div>
      </div>
    </Pane>
  </Splitpanes>
</template>

<style>
.splitpanes {
  --height: v-bind(height);
  position: relative;
  display: flex;
  height: calc(100% - var(--height));
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
}

button:hover {
  color: v-bind(statusBarForeground);
  background-color: v-bind(tabHoverBackground);
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
