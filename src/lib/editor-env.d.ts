/// <reference types="vite/client" />

declare module 'virtual:editor-node-types' {
  const definitions: { path: string; content: string }[]
  export default definitions
}

declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor'
}

// Monaco exposes these ESM worker exports without publishing their declarations.
declare module 'monaco-editor/esm/vs/language/typescript/ts.worker.js' {
  export class TypeScriptWorker {
    constructor(context: unknown, createData: unknown)
    getScriptFileNames(): string[]
    getScriptKind(fileName: string): number
  }
  export const ts: { ScriptKind: { TS: number; JSON: number } }
  export function initialize(
    factory: (context: unknown, createData: unknown) => TypeScriptWorker
  ): void
}
