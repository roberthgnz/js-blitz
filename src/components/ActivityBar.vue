<script lang="ts" setup>
import ClearIcon from './icons/Clear.vue'
import RunIcon from './icons/Run.vue'
import SettingsIcon from './icons/Settings.vue'

defineEmits<{
  (event: 'run-code'): void
  (event: 'clear-output'): void
  (event: 'show-context-menu'): void
}>()
</script>

<template>
  <div class="size-full flex flex-col items-center">
    <button
      type="button"
      class="p-2 select-none"
      title="Run code (CtrlCmd + Enter)"
      @click="$emit('run-code')"
    >
      <RunIcon class="size-4" />
    </button>
    <button
      type="button"
      class="p-2 select-none"
      title="Clear output"
      @click="$emit('clear-output')"
    >
      <ClearIcon class="size-4" />
    </button>
    <button
      type="button"
      class="p-2 select-none mt-auto"
      title="Settings"
      @click="$emit('show-context-menu')"
    >
      <SettingsIcon class="size-4" />
    </button>
  </div>
</template>
