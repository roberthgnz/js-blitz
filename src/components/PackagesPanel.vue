<script setup lang="ts">
import { computed, ref } from 'vue'

import Icon from './Icon.vue'

const props = defineProps<{
  packages: Array<{ name: string; version: string }>
  busy: boolean
  error: string
}>()
const emit = defineEmits<{ (event: 'install', name: string): void }>()

const name = ref('')
const filter = ref('')
const visible = computed(() => {
  const search = filter.value.trim().toLowerCase()
  return search
    ? props.packages.filter((pkg) => pkg.name.toLowerCase().includes(search))
    : props.packages
})

function install() {
  const value = name.value.trim()
  if (!value || props.busy) return
  emit('install', value)
}

defineExpose({ clear: () => (name.value = '') })
</script>

<template>
  <section class="panel" aria-label="npm packages">
    <form class="install-form" @submit.prevent="install">
      <label for="package-name" class="field-label">Install from npm</label>
      <div class="input-group">
        <Icon name="package" :size="15" />
        <input
          id="package-name"
          v-model="name"
          placeholder="lodash, nanoid@5, @scope/pkg"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <button
        class="btn btn-primary"
        type="submit"
        :disabled="busy || !name.trim()"
      >
        <Icon v-if="busy" name="loader" :size="14" class="spin" />
        {{ busy ? 'Installing…' : 'Install package' }}
      </button>
    </form>

    <div class="callout">
      <Icon name="zap" :size="14" />
      <p>
        Missing imports install automatically when you run. Packages are shared
        by every tab.
      </p>
    </div>

    <p v-if="error" class="callout callout-error" role="alert">
      <Icon name="error" :size="14" /><span>{{ error }}</span>
    </p>

    <div class="list-header">
      <span>Installed</span>
      <span class="count">{{ packages.length }}</span>
    </div>
    <div v-if="packages.length > 6" class="input-group input-group-sm">
      <Icon name="search" :size="13" />
      <input
        v-model="filter"
        placeholder="Filter packages"
        aria-label="Filter installed packages"
      />
    </div>
    <ul v-if="visible.length" class="package-list">
      <li v-for="pkg in visible" :key="pkg.name">
        <span class="package-name">{{ pkg.name }}</span>
        <span class="package-version">{{ pkg.version }}</span>
      </li>
    </ul>
    <div v-else-if="!packages.length" class="empty">
      <Icon name="package" :size="28" />
      <strong>No packages yet</strong>
      <span>Import one in your code or install it above.</span>
    </div>
    <p v-else class="hint">No packages match “{{ filter }}”.</p>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
}
.install-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.package-list {
  display: flex;
  flex-direction: column;
  margin: -6px 0 0;
  padding: 0;
  list-style: none;
}
.package-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
}
.package-list li:hover {
  background: var(--ui-hover);
}
.package-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
}
.package-version {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--ui-surface-2);
  color: var(--ui-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
