<script lang="ts" setup>
import { ref } from 'vue'

import Close from './icons/Close.vue'
import Maximize from './icons/Maximize.vue'
import Minimize from './icons/Minimize.vue'
import Restore from './icons/Restore.vue'

const isMaximized = ref(false)

const minimizeWindow = () => {
  isMaximized.value = false
  window.electronAPI.minimizeWindow()
}

const maximizeWindow = () => {
  isMaximized.value = !isMaximized.value
  window.electronAPI.maximizeWindow()
}

const closeWindow = () => {
  window.electronAPI.closeWindow()
}
</script>

<template>
  <div id="titlebar" class="w-full flex items-center justify-between">
    <img src="../../icon.png" alt="Logo" class="size-8" />
    <div>
      <button
        type="button"
        title="Minimize"
        class="action px-4 py-2"
        @click="minimizeWindow"
      >
        <Minimize />
      </button>
      <button
        type="button"
        :title="isMaximized ? 'Restore' : 'Maximize'"
        class="action px-4 py-2"
        @click="maximizeWindow"
      >
        <Maximize v-if="!isMaximized" />
        <Restore v-else />
      </button>
      <button
        type="button"
        title="Close"
        class="action action--close px-4 py-2"
        @click="closeWindow"
      >
        <Close />
      </button>
    </div>
  </div>
</template>

<style>
#titlebar {
  -webkit-user-select: none;
  -webkit-app-region: drag;
}

button.action {
  color: var(--buttonSecondaryForeground);
  transition: background-color 0.2s;
  -webkit-app-region: no-drag;
}

button.action:hover {
  background-color: var(--buttonSecondaryHoverBackground);
}

button.action--close:hover {
  background-color: #ff5f56;
}
</style>
