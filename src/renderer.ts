import { createApp } from 'vue'
import { install as VueMonacoEditorPlugin } from '@guolao/vue-monaco-editor'
import { Tooltip, vTooltip } from 'floating-vue'
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
import './style.css'
import 'floating-vue/dist/style.css'

import App from './App.vue'
import { configureEditor, disposeEditorTools } from './lib/editor'
import TypeScriptWorker from './lib/typescript.worker?worker'

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    return label === 'typescript' || label === 'javascript'
      ? new TypeScriptWorker()
      : new EditorWorker()
  },
}

configureEditor(monaco)

const app = createApp(App)

app.directive('tooltip', vTooltip)
app.component('VTooltip', Tooltip)

app.use(VueMonacoEditorPlugin, { monaco })

app.mount('#app')

if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeEditorTools(monaco))
}
