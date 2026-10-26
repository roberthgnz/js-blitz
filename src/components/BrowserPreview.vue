<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import type { BrowserExecution } from '../lib/browser-runner'

const props = defineProps<{ execution?: BrowserExecution }>()
const host = ref<HTMLElement>()
watch(
  () => [host.value, props.execution] as const,
  ([element, execution]) => {
    if (element && execution?.frame) element.replaceChildren(execution.frame)
    else element?.replaceChildren()
  },
  { flush: 'post' }
)
onBeforeUnmount(() => props.execution?.dispose())
</script>
<template>
  <div class="browser-preview" aria-label="Browser preview">
    <div ref="host" class="browser-preview-host"></div>
    <div v-if="!execution" class="browser-preview-empty">
      <strong>Browser preview</strong>
      <p>
        Run code using document, canvas or other browser APIs to see the result
        here.
      </p>
    </div>
  </div>
</template>
<style scoped>
.browser-preview {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #fff;
}
.browser-preview-host {
  width: 100%;
  height: 100%;
}
.browser-preview-host :deep(iframe) {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.browser-preview-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: #666;
  font-size: 13px;
  text-align: center;
}
.browser-preview-empty p {
  max-width: 300px;
  line-height: 1.6;
}
</style>
