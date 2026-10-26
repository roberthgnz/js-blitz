<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import Icon, { type IconName } from './Icon.vue'

export interface PaletteCommand {
  id: string
  label: string
  group: string
  icon?: IconName
  shortcut?: string
  disabled?: boolean
  run: () => void
}

const props = defineProps<{ commands: PaletteCommand[] }>()
const emit = defineEmits<{ (event: 'close'): void }>()

const query = ref('')
const activeIndex = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLUListElement | null>(null)

/** Subsequence match; earlier and tighter matches rank first. */
function score(label: string, search: string) {
  if (!search) return 0
  const text = label.toLowerCase()
  const direct = text.indexOf(search)
  if (direct >= 0) return direct
  let position = -1
  let gaps = 0
  for (const char of search) {
    const next = text.indexOf(char, position + 1)
    if (next < 0) return -1
    gaps += next - position - 1
    position = next
  }
  return 100 + gaps
}

const results = computed(() => {
  const search = query.value.trim().toLowerCase()
  return props.commands
    .filter((command) => !command.disabled)
    .map((command) => {
      const scores = [
        score(command.label, search),
        score(`${command.group} ${command.label}`, search),
      ].filter((value) => value >= 0)
      return { command, score: scores.length ? Math.min(...scores) : -1 }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.command)
})

watch(query, () => (activeIndex.value = 0))
watch(activeIndex, async (index) => {
  await nextTick()
  list.value
    ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    ?.scrollIntoView({ block: 'nearest' })
})

function execute(command: PaletteCommand | undefined) {
  if (!command) return
  emit('close')
  // Let the palette unmount and focus return before the command runs.
  requestAnimationFrame(() => command.run())
}

function onKeydown(event: KeyboardEvent) {
  const count = results.value.length
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = count ? (activeIndex.value + 1) % count : 0
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = count ? (activeIndex.value - 1 + count) % count : 0
  } else if (event.key === 'Enter') {
    event.preventDefault()
    execute(results.value[activeIndex.value])
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="palette-backdrop" @mousedown.self="emit('close')">
    <div
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div class="palette-search">
        <Icon name="search" :size="16" />
        <input
          ref="input"
          v-model="query"
          type="text"
          placeholder="Type a command…"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          :aria-activedescendant="
            results.length ? `palette-item-${activeIndex}` : undefined
          "
          spellcheck="false"
          autocomplete="off"
          @keydown="onKeydown"
        />
        <kbd>Esc</kbd>
      </div>
      <ul
        id="palette-results"
        ref="list"
        class="palette-results"
        role="listbox"
      >
        <li
          v-for="(command, index) in results"
          :id="`palette-item-${index}`"
          :key="command.id"
          :data-index="index"
          role="option"
          :aria-selected="index === activeIndex"
          class="palette-item"
          :class="{ active: index === activeIndex }"
          @mousemove="activeIndex = index"
          @click="execute(command)"
        >
          <span class="palette-icon"
            ><Icon v-if="command.icon" :name="command.icon" :size="15"
          /></span>
          <span class="palette-group">{{ command.group }}</span>
          <span class="palette-label">{{ command.label }}</span>
          <kbd v-if="command.shortcut">{{ command.shortcut }}</kbd>
        </li>
        <li v-if="!results.length" class="palette-empty">
          No matching commands
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 72px;
  background: color-mix(in srgb, #000 35%, transparent);
  animation: fade-in 0.12s ease-out;
}
.palette {
  width: min(600px, calc(100vw - 32px));
  overflow: hidden;
  border: 1px solid var(--ui-border-strong);
  border-radius: 12px;
  background: var(--ui-popover);
  box-shadow:
    0 24px 64px -12px #000a,
    0 0 0 1px #0004;
  animation: pop-in 0.14s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.palette-search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-muted);
}
.palette-search input {
  flex: 1;
  min-width: 0;
  height: 48px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ui-fg);
  font-size: 14px;
}
.palette-search input::placeholder {
  color: var(--ui-subtle);
}
.palette-results {
  max-height: min(420px, 60vh);
  overflow-y: auto;
  margin: 0;
  padding: 6px;
  list-style: none;
}
.palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: 7px;
  color: var(--ui-fg);
  cursor: pointer;
}
.palette-item.active {
  background: var(--ui-accent-soft);
}
.palette-icon {
  display: grid;
  place-items: center;
  width: 16px;
  color: var(--ui-muted);
}
.palette-item.active .palette-icon {
  color: var(--ui-accent);
}
.palette-group {
  color: var(--ui-subtle);
  white-space: nowrap;
}
.palette-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-empty {
  padding: 18px 12px;
  color: var(--ui-muted);
  text-align: center;
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
}
@keyframes pop-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
}
@media (prefers-reduced-motion: reduce) {
  .palette-backdrop,
  .palette {
    animation: none;
  }
}
</style>
