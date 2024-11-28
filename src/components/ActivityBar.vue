<script lang="ts" setup>
import ClearIcon from './icons/Clear.vue'
import DownloadIcon from './icons/Download.vue'
import RunIcon from './icons/Run.vue'
import SettingsIcon from './icons/Settings.vue'

defineEmits<{
  (event: 'run-code'): void
  (event: 'clear-output'): void
  (event: 'download-code'): void
  (event: 'show-context-menu'): void
}>()
</script>

<template>
  <div class="size-full flex flex-col items-center">
    <button
      type="button"
      class="py-4 px-2 select-none"
      v-tooltip.right="{ content: 'Run code (CtrlCmd + Enter)', delay: 100 }"
      @click="$emit('run-code')"
    >
      <RunIcon class="size-4" />
    </button>
    <button
      type="button"
      class="py-4 px-2 select-none"
      v-tooltip.right="{ content: 'Clear output', delay: 100 }"
      @click="$emit('clear-output')"
    >
      <ClearIcon class="size-4" />
    </button>
    <button
      type="button"
      class="py-4 px-2 select-none"
      v-tooltip.right="{ content: 'Download code', delay: 100 }"
      @click="$emit('download-code')"
    >
      <DownloadIcon class="size-4" />
    </button>
    <button
      type="button"
      class="py-4 px-2 select-none mt-auto"
      v-tooltip.right="{ content: 'Settings', delay: 100 }"
      @click="$emit('show-context-menu')"
    >
      <SettingsIcon class="size-4" />
    </button>
  </div>
</template>

<style>
.v-popper__inner {
  @apply !text-xs;
}
</style>
