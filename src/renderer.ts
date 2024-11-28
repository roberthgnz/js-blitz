import { createApp } from 'vue'
import { install as VueMonacoEditorPlugin } from '@guolao/vue-monaco-editor'
import { Tooltip, vTooltip } from 'floating-vue'

import './style.css'
import 'floating-vue/dist/style.css'

import App from './App.vue'

const app = createApp(App)

app.directive('tooltip', vTooltip)
app.component('VTooltip', Tooltip)

app.use(VueMonacoEditorPlugin, {
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs',
  },
})

app.mount('#app')
