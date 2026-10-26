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
import { initializeDesktopBridge } from './lib/desktop'
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

async function mountApp() {
  await initializeDesktopBridge()

  const app = createApp(App)

  app.directive('tooltip', vTooltip)
  app.component('VTooltip', Tooltip)

  app.use(VueMonacoEditorPlugin, { monaco })
  app.mount('#app')
}

void mountApp().catch((error: unknown) => {
  console.error('Unable to initialize the desktop bridge:', error)
  const root = document.getElementById('app')
  if (root)
    root.textContent =
      'JSBlitz could not connect to its desktop event listener. Please restart the desktop app. ' +
      (error instanceof Error ? error.message : String(error))
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeEditorTools(monaco))
}
