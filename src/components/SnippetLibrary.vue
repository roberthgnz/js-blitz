<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  parseSnippets,
  savedSnippets,
  type SavedSnippet,
} from '../lib/snippets'
import Icon from './Icon.vue'

const props = defineProps<{ code: string }>()
const emit = defineEmits<{
  (event: 'insert', code: string): void
  (event: 'new-tab', code: string): void
}>()
const editing = ref(false)
const selected = ref('')
const name = ref('')
const description = ref('')
const body = ref('')
const message = ref<{ text: string; tone: 'success' | 'error' } | null>(null)
const filter = ref('')
const visible = computed(() => {
  const search = filter.value.trim().toLowerCase()
  return search
    ? savedSnippets.value.filter((snippet) =>
        (snippet.name + ' ' + snippet.description)
          .toLowerCase()
          .includes(search)
      )
    : savedSnippets.value
})
function select(snippet: SavedSnippet) {
  editing.value = true
  selected.value = snippet.id
  name.value = snippet.name
  description.value = snippet.description
  body.value = snippet.body
  message.value = null
}
function create() {
  editing.value = true
  selected.value = ''
  name.value = ''
  description.value = ''
  body.value = props.code
  message.value = null
}
function close() {
  editing.value = false
  selected.value = ''
  message.value = null
}
function save() {
  if (!name.value.trim()) {
    message.value = { text: 'Enter a snippet name.', tone: 'error' }
    return
  }
  if (
    body.value.length > 300000 ||
    (!selected.value && savedSnippets.value.length >= 500)
  ) {
    message.value = {
      text: 'Use up to 500 snippets, with at most 300,000 characters each.',
      tone: 'error',
    }
    return
  }
  const entry = {
    id: selected.value || crypto.randomUUID(),
    name: name.value.trim(),
    description: description.value,
    body: body.value,
  }
  const index = savedSnippets.value.findIndex((item) => item.id === entry.id)
  if (index >= 0) savedSnippets.value[index] = entry
  else savedSnippets.value.push(entry)
  selected.value = entry.id
  message.value = {
    text: 'Saved. Type its name in the editor to insert it.',
    tone: 'success',
  }
}
function remove() {
  savedSnippets.value = savedSnippets.value.filter(
    (item) => item.id !== selected.value
  )
  close()
  message.value = { text: 'Snippet deleted.', tone: 'success' }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    if (file.size > 5 * 1024 * 1024)
      throw new Error('Choose a JSON file smaller than 5 MB.')
    const imported = parseSnippets(JSON.parse(await file.text()))
    if (savedSnippets.value.length + imported.length > 500)
      throw new Error('The library can hold up to 500 snippets.')
    savedSnippets.value.push(...imported)
    message.value = {
      text: imported.length + ' snippets imported.',
      tone: 'success',
    }
  } catch (error) {
    message.value = {
      text: error instanceof Error ? error.message : String(error),
      tone: 'error',
    }
  }
  input.value = ''
}
function exportFile() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(savedSnippets.value, null, 2)], {
      type: 'application/json',
    })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = 'jsblitz-snippets.json'
  link.click()
  URL.revokeObjectURL(url)
}

defineExpose({ create })
</script>
<template>
  <section class="panel" aria-label="Snippet library">
    <template v-if="!editing">
      <div class="toolbar">
        <div class="input-group input-group-sm">
          <Icon name="search" :size="13" />
          <input
            v-model="filter"
            placeholder="Search snippets"
            aria-label="Search snippets"
          />
        </div>
        <label class="icon-btn file-btn" title="Import snippets (JSON)">
          <Icon name="upload" :size="15" />
          <input
            type="file"
            accept=".json,application/json"
            aria-label="Import snippets"
            @change="importFile"
          />
        </label>
        <button
          class="icon-btn"
          title="Export snippets"
          aria-label="Export snippets"
          :disabled="!savedSnippets.length"
          @click="exportFile"
        >
          <Icon name="download" :size="15" />
        </button>
      </div>
      <button class="btn btn-primary" @click="create">
        <Icon name="plus" :size="14" /> Save editor code as snippet
      </button>
      <p
        v-if="message"
        role="status"
        class="callout"
        :class="{ 'callout-error': message.tone === 'error' }"
      >
        {{ message.text }}
      </p>
      <div class="list-header">
        <span>Library</span
        ><span class="count">{{ savedSnippets.length }}</span>
      </div>
      <ul
        v-if="visible.length"
        class="snippet-list"
        aria-label="Saved snippets"
      >
        <li v-for="snippet in visible" :key="snippet.id">
          <button class="snippet-card" @click="select(snippet)">
            <span class="snippet-name">{{ snippet.name }}</span>
            <span class="snippet-desc">{{
              snippet.description || snippet.body.split('\n')[0]
            }}</span>
          </button>
          <div class="snippet-actions">
            <button
              class="icon-btn"
              title="Insert at cursor"
              :aria-label="'Insert ' + snippet.name + ' at cursor'"
              @click="emit('insert', snippet.body)"
            >
              <Icon name="insert" :size="14" />
            </button>
            <button
              class="icon-btn"
              title="Open in new tab"
              :aria-label="'Open ' + snippet.name + ' in new tab'"
              @click="emit('new-tab', snippet.body)"
            >
              <Icon name="file-plus" :size="14" />
            </button>
          </div>
        </li>
      </ul>
      <div v-else-if="!savedSnippets.length" class="empty">
        <Icon name="bookmark" :size="28" />
        <strong>No snippets yet</strong>
        <span>Save reusable code, then insert it by typing its name.</span>
      </div>
      <p v-else class="hint">No snippets match “{{ filter }}”.</p>
    </template>

    <form v-else class="snippet-form" @submit.prevent="save">
      <button type="button" class="back-btn" @click="close">
        <Icon name="arrow-left" :size="14" /> All snippets
      </button>
      <label class="field">
        <span class="field-label">Name</span>
        <input
          v-model="name"
          class="input mono"
          maxlength="100"
          placeholder="fetch-helper"
        />
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <input
          v-model="description"
          class="input"
          maxlength="1000"
          placeholder="Optional"
        />
      </label>
      <label class="field">
        <span class="field-label">Code</span>
        <textarea
          v-model="body"
          class="input mono"
          rows="10"
          spellcheck="false"
          placeholder="Your reusable JavaScript or TypeScript"
        ></textarea>
      </label>
      <p
        v-if="message"
        role="status"
        class="callout"
        :class="{ 'callout-error': message.tone === 'error' }"
      >
        {{ message.text }}
      </p>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          <Icon name="check" :size="14" /> Save
        </button>
        <button
          type="button"
          class="btn"
          :disabled="!body"
          @click="emit('insert', body)"
        >
          Insert
        </button>
        <button
          type="button"
          class="btn"
          :disabled="!body"
          @click="emit('new-tab', body)"
        >
          New tab
        </button>
        <button
          v-if="selected"
          type="button"
          class="icon-btn danger"
          title="Delete snippet"
          aria-label="Delete snippet"
          @click="remove"
        >
          <Icon name="trash" :size="15" />
        </button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
}
.toolbar .input-group {
  flex: 1;
}
.file-btn {
  position: relative;
  overflow: hidden;
}
.file-btn input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.snippet-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: -4px 0 0;
  padding: 0;
  list-style: none;
}
.snippet-list li {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 7px;
}
.snippet-list li:hover {
  background: var(--ui-hover);
}
.snippet-card {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  text-align: left;
}
.snippet-name {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-fg);
}
.snippet-name,
.snippet-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.snippet-desc {
  color: var(--ui-subtle);
  font-size: 11px;
}
.snippet-actions {
  display: flex;
  padding-right: 4px;
  opacity: 0;
  transition: opacity 0.12s;
}
.snippet-list li:hover .snippet-actions,
.snippet-list li:focus-within .snippet-actions {
  opacity: 1;
}
.snippet-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  color: var(--ui-muted);
  font-size: 12px;
}
.back-btn:hover {
  color: var(--ui-fg);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.snippet-form textarea {
  min-height: 160px;
  resize: vertical;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.form-actions .danger {
  margin-left: auto;
}
</style>
