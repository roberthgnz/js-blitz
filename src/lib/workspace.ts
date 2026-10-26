export type Language = 'javascript' | 'typescript'
export interface CodeTab {
  id: string
  name: string
  language: Language
  code: string
}
export const DEFAULT_CODE = `// JavaScript, TypeScript and Node.js — ready to run.
import { randomUUID } from 'node:crypto'
const greeting: string = 'Hello from JSBlitz!'
console.log(greeting)
await new Promise(resolve => setTimeout(resolve, 100));
({ id: randomUUID(), node: process.version })
`
export function createTab(index = 1, code = DEFAULT_CODE): CodeTab {
  return {
    id: crypto.randomUUID(),
    name: `Scratch ${index}`,
    language: 'typescript',
    code,
  }
}
export function loadTabs(storage: Storage): CodeTab[] {
  try {
    const saved: unknown = JSON.parse(
      storage.getItem('js-blitz-tabs') || 'null'
    )
    if (Array.isArray(saved)) {
      const ids = new Set<string>()
      const tabs = saved.filter((tab): tab is CodeTab => {
        if (!tab || typeof tab !== 'object') return false
        const valid =
          typeof tab.id === 'string' &&
          /^[\w-]+$/.test(tab.id) &&
          !ids.has(tab.id) &&
          typeof tab.name === 'string' &&
          typeof tab.code === 'string' &&
          (tab.language === 'javascript' || tab.language === 'typescript')
        if (valid) ids.add(tab.id)
        return valid
      })
      if (tabs.length) return tabs
    }
  } catch {
    /* Recover invalid workspace storage. */
  }
  return [createTab(1, storage.getItem('js-blitz-input-code') ?? DEFAULT_CODE)]
}
