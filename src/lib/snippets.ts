import { ref, watch } from 'vue'

export interface SavedSnippet {
  id: string
  name: string
  description: string
  body: string
}
export function parseSnippets(value: unknown): SavedSnippet[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error('Choose a JSON array with up to 500 snippets.')
  return value.map((item) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      typeof item.body !== 'string' ||
      item.body.length > 300000
    )
      throw new Error(
        'Every snippet needs a name and a code body (up to 300,000 characters).'
      )
    return {
      id: crypto.randomUUID(),
      name: item.name.slice(0, 100),
      description:
        typeof item.description === 'string'
          ? item.description.slice(0, 1000)
          : '',
      body: item.body,
    }
  })
}
let initial: SavedSnippet[] = []
try {
  initial = parseSnippets(
    JSON.parse(localStorage.getItem('js-blitz-snippets') || '[]')
  )
} catch {
  /* Start with an empty library if storage is damaged. */
}
export const savedSnippets = ref(initial)
watch(
  savedSnippets,
  (value) => localStorage.setItem('js-blitz-snippets', JSON.stringify(value)),
  { deep: true }
)
