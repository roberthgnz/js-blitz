<script setup lang="ts">
import { ref } from 'vue'

import {
  parseSnippets,
  savedSnippets,
  type SavedSnippet,
} from '../lib/snippets'

const props = defineProps<{ code: string }>()
const emit = defineEmits<{
  (event: 'insert', code: string): void
  (event: 'new-tab', code: string): void
}>()
const selected = ref('')
const name = ref('')
const description = ref('')
const body = ref('')
const message = ref('')
function select(snippet: SavedSnippet) {
  selected.value = snippet.id
  name.value = snippet.name
  description.value = snippet.description
  body.value = snippet.body
  message.value = ''
}
function create() {
  selected.value = ''
  name.value = ''
  description.value = ''
  body.value = props.code
  message.value = ''
}
function save() {
  if (!name.value.trim()) {
    message.value = 'Enter a snippet name.'
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
  message.value =
    'Snippet saved. Type its name in the editor to use autocomplete.'
}
function remove() {
  savedSnippets.value = savedSnippets.value.filter(
    (item) => item.id !== selected.value
  )
  selected.value = ''
  name.value = ''
  description.value = ''
  body.value = ''
  message.value = 'Snippet deleted.'
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
    message.value = imported.length + ' snippets imported.'
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
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
</script>
<template>
  <section class="snippet-library" aria-label="Snippet library">
    <div class="snippet-actions">
      <strong>Snippets</strong><button @click="create">New from editor</button
      ><label class="import-snippets"
        >Import<input
          type="file"
          accept=".json,application/json"
          @change="importFile" /></label
      ><button @click="exportFile" :disabled="!savedSnippets.length">
        Export
      </button>
    </div>
    <div class="snippet-layout">
      <nav aria-label="Saved snippets">
        <button
          v-for="snippet in savedSnippets"
          :key="snippet.id"
          :class="{ selected: selected === snippet.id }"
          @click="select(snippet)"
        >
          {{ snippet.name }}
        </button>
        <p v-if="!savedSnippets.length" class="hint">
          Save reusable code and insert it by name.
        </p>
      </nav>
      <form @submit.prevent="save">
        <label
          >Name<input v-model="name" maxlength="100" placeholder="fetch-helper"
        /></label>
        <label
          >Description<input
            v-model="description"
            maxlength="1000"
            placeholder="Optional description"
        /></label>
        <label
          >Code<textarea
            v-model="body"
            rows="5"
            spellcheck="false"
            placeholder="Your reusable JavaScript or TypeScript"
          ></textarea>
        </label>
        <div class="snippet-actions">
          <button type="submit">Save</button
          ><button type="button" :disabled="!selected" @click="remove">
            Delete</button
          ><button
            type="button"
            :disabled="!body"
            @click="emit('insert', body)"
          >
            Insert at cursor</button
          ><button
            type="button"
            :disabled="!body"
            @click="emit('new-tab', body)"
          >
            Open in new tab
          </button>
        </div>
      </form>
    </div>
    <p v-if="message" role="status" class="hint">{{ message }}</p>
  </section>
</template>
<style scoped>
.snippet-library {
  background: #232430;
  border-bottom: 1px solid #ffffff20;
  padding: 12px 16px;
  max-height: 380px;
  overflow: auto;
}
.snippet-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.snippet-actions strong {
  margin-right: auto;
}
.snippet-layout {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
}
nav {
  border-right: 1px solid #ffffff18;
  padding-right: 10px;
  max-height: 240px;
  overflow: auto;
}
nav button {
  display: block;
  width: 100%;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
}
nav button.selected {
  background: #bd93f930;
}
form {
  display: grid;
  gap: 6px;
}
form label {
  display: grid;
  grid-template-columns: 85px 1fr;
  align-items: start;
  gap: 8px;
}
input,
textarea {
  width: 100%;
  min-width: 0;
  padding: 5px 8px;
  background: #30313e;
  border: 1px solid #ffffff20;
  border-radius: 4px;
}
textarea {
  font-family: Consolas, monospace;
  resize: vertical;
}
.import-snippets {
  position: relative;
  cursor: pointer;
  padding: 5px 9px;
  overflow: hidden;
}
.import-snippets input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
</style>
