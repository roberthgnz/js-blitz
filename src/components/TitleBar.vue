<script lang="ts" setup>
import { ref } from 'vue'

import { desktopAPI, isDesktopAvailable } from '../lib/desktop'
import Close from './icons/Close.vue'
import Maximize from './icons/Maximize.vue'
import Minimize from './icons/Minimize.vue'
import Restore from './icons/Restore.vue'

const isMaximized = ref(false)
const windowError = ref('')

const minimizeWindow = async () => {
  try {
    await desktopAPI.minimizeWindow()
    windowError.value = ''
  } catch (error) {
    windowError.value = error instanceof Error ? error.message : String(error)
  }
}

const maximizeWindow = async () => {
  try {
    await desktopAPI.maximizeWindow()
    isMaximized.value = !isMaximized.value
    windowError.value = ''
  } catch (error) {
    windowError.value = error instanceof Error ? error.message : String(error)
  }
}

const closeWindow = async () => {
  try {
    await desktopAPI.closeWindow()
    windowError.value = ''
  } catch (error) {
    windowError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div
    id="titlebar"
    class="w-full flex items-center justify-between"
    data-tauri-drag-region
  >
    <img
      src="../../icon-square.png"
      alt="Logo"
      class="size-8"
      data-tauri-drag-region
      draggable="false"
    />
    <span v-if="windowError" role="alert">{{ windowError }}</span>
    <div>
      <button
        type="button"
        title="Minimize"
        :disabled="!isDesktopAvailable()"
        class="action px-4 py-2"
        @click="minimizeWindow"
      >
        <Minimize />
      </button>
      <button
        type="button"
        :title="isMaximized ? 'Restore' : 'Maximize'"
        :disabled="!isDesktopAvailable()"
        class="action px-4 py-2"
        @click="maximizeWindow"
      >
        <Maximize v-if="!isMaximized" />
        <Restore v-else />
      </button>
      <button
        type="button"
        title="Close"
        :disabled="!isDesktopAvailable()"
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
  user-select: none;
}

button.action {
  opacity: 0.75;
  color: var(--buttonForeground);
  transition: all 0.2s;
}

button.action:hover {
  opacity: 1;
  color: var(--buttonHoverForeground);
  background-color: #ffffff1a;
}

button.action--close:hover {
  background-color: #ff5f56;
}
</style>
