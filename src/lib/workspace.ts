import type { ExecutionEnvironment } from '../../types'

export type Language = 'javascript' | 'typescript'
export interface CodeTab {
  id: string
  name: string
  language: Language
  environment: ExecutionEnvironment
  code: string
}
export const DEFAULT_CODE = `// JavaScript, TypeScript and Node.js — ready to run.
import { randomUUID } from 'node:crypto'
const greeting: string = 'Hello from JSBlitz!'
console.log(greeting)
await new Promise(resolve => setTimeout(resolve, 100));
({ id: randomUUID(), node: process.version })
`
export const BROWSER_DEFAULT_CODE = `// Browser APIs run in their own preview.
const data = [12, 25, 8, 30, 18, 22]
const canvas = document.createElement('canvas')
canvas.width = 320
canvas.height = 140
document.body.append(canvas)

const ctx = canvas.getContext('2d')
if (!ctx) throw new Error('This browser does not support a 2D canvas')
ctx.fillStyle = '#8661eb'
data.forEach((value, index) => {
  ctx.beginPath()
  ctx.roundRect(index * 50 + 4, 130 - value * 4, 42, value * 4, 4)
  ctx.fill()
})
console.log('Canvas ready:', canvas.width, canvas.height)
`
export function createTab(
  index = 1,
  code?: string,
  environment: ExecutionEnvironment = 'node'
): CodeTab {
  return {
    id: crypto.randomUUID(),
    name: `Scratch ${index}`,
    language: 'typescript',
    environment,
    code:
      code ?? (environment === 'browser' ? BROWSER_DEFAULT_CODE : DEFAULT_CODE),
  }
}
export function loadTabs(
  storage: Storage,
  defaultEnvironment: ExecutionEnvironment = 'node'
): CodeTab[] {
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
      if (tabs.length)
        return tabs.map((tab) => ({
          ...tab,
          environment:
            tab.environment === 'node' || tab.environment === 'browser'
              ? tab.environment
              : defaultEnvironment,
        }))
    }
  } catch {
    /* Recover invalid workspace storage. */
  }
  return [
    createTab(
      1,
      storage.getItem('js-blitz-input-code') ?? undefined,
      defaultEnvironment
    ),
  ]
}
