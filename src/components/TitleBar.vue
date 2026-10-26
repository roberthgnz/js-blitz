<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { desktopAPI, isDesktopAvailable } from '../lib/desktop'
import Close from './icons/Close.vue'
import Maximize from './icons/Maximize.vue'
import Minimize from './icons/Minimize.vue'
import Restore from './icons/Restore.vue'

const isMaximized = ref(false)
const windowError = ref('')
let stopResizeListener: (() => void) | undefined
let disposed = false

async function syncMaximized() {
  try {
    isMaximized.value = await getCurrentWindow().isMaximized()
  } catch {
    /* Keep the last known state when the query is unavailable. */
  }
}

onMounted(async () => {
  if (!isDesktopAvailable()) return
  await syncMaximized()
  try {
    const unlisten = await getCurrentWindow().onResized(() => syncMaximized())
    if (disposed) unlisten()
    else stopResizeListener = unlisten
  } catch {
    /* Maximize state then only follows the title bar button. */
  }
})
onBeforeUnmount(() => {
  disposed = true
  stopResizeListener?.()
})

async function windowAction(action: () => Promise<void>) {
  try {
    await action()
    windowError.value = ''
  } catch (error) {
    windowError.value = error instanceof Error ? error.message : String(error)
  }
}

const minimizeWindow = () => windowAction(() => desktopAPI.minimizeWindow())
const maximizeWindow = () =>
  windowAction(async () => {
    await desktopAPI.maximizeWindow()
    if (!stopResizeListener) isMaximized.value = !isMaximized.value
  })
const closeWindow = () => windowAction(() => desktopAPI.closeWindow())
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div class="titlebar-start" data-tauri-drag-region>
      <img
        src="../../icon-square.png"
        alt=""
        class="titlebar-logo"
        draggable="false"
        data-tauri-drag-region
      />
      <span class="titlebar-name" data-tauri-drag-region>JSBlitz</span>
      <slot name="start" />
    </div>
    <div class="titlebar-center" data-tauri-drag-region>
      <slot />
    </div>
    <div class="titlebar-end" data-tauri-drag-region>
      <span v-if="windowError" class="titlebar-error" role="alert">{{
        windowError
      }}</span>
      <slot name="end" />
      <div class="window-controls">
        <button
          type="button"
          title="Minimize"
          aria-label="Minimize"
          :disabled="!isDesktopAvailable()"
          class="window-control"
          @click="minimizeWindow"
        >
          <Minimize />
        </button>
        <button
          type="button"
          :title="isMaximized ? 'Restore' : 'Maximize'"
          :aria-label="isMaximized ? 'Restore' : 'Maximize'"
          :disabled="!isDesktopAvailable()"
          class="window-control"
          @click="maximizeWindow"
        >
          <Restore v-if="isMaximized" />
          <Maximize v-else />
        </button>
        <button
          type="button"
          title="Close"
          aria-label="Close"
          :disabled="!isDesktopAvailable()"
          class="window-control window-control--close"
          @click="closeWindow"
        >
          <Close />
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: grid;
  /* Center stays centered while there is room, then yields to the sides. */
  grid-template-columns: minmax(max-content, 1fr) minmax(0, 420px) minmax(
      max-content,
      1fr
    );
  align-items: center;
  height: 44px;
  flex-shrink: 0;
  padding-left: 12px;
  background: var(--ui-chrome);
  border-bottom: 1px solid var(--ui-border);
  -webkit-user-select: none;
  user-select: none;
}
.titlebar-start,
.titlebar-end {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 100%;
}
.titlebar-end {
  justify-content: flex-end;
}
.titlebar-center {
  display: flex;
  justify-content: center;
  min-width: 0;
  padding: 0 12px;
}
.titlebar-logo {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  pointer-events: none;
}
.titlebar-name {
  font-weight: 600;
  font-size: 13px;
  letter-spacing: -0.01em;
  color: var(--ui-fg);
}
.titlebar-error {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-danger);
  font-size: 11px;
}
.window-controls {
  display: flex;
  align-self: stretch;
  margin-left: 4px;
}
.window-control {
  display: grid;
  place-items: center;
  width: 46px;
  height: 100%;
  color: var(--ui-muted);
  transition:
    background-color 0.12s,
    color 0.12s;
}
.window-control:hover:not(:disabled) {
  color: var(--ui-fg);
  background: var(--ui-hover);
}
.window-control--close:hover:not(:disabled) {
  color: #fff;
  background: #e81123;
}
.window-control:disabled {
  opacity: 0.35;
}
.window-control :deep(svg) {
  width: 14px;
  height: 14px;
}
@media (max-width: 720px) {
  .titlebar {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .titlebar-name {
    display: none;
  }
}
</style>
