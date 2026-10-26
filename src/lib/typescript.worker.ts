import {
  initialize,
  ts,
  TypeScriptWorker,
} from 'monaco-editor/esm/vs/language/typescript/ts.worker.js'

class WorkspaceTypeScriptWorker extends TypeScriptWorker {
  getScriptFileNames() {
    // Manifests participate in module resolution, rather than becoming JS files.
    return super.getScriptFileNames().filter((name) => !name.endsWith('.json'))
  }

  getScriptKind(fileName: string) {
    // Monaco 0.52's host predates .mts/.cts and otherwise treats them as JS.
    if (/\.(?:mts|cts)$/.test(fileName)) return ts.ScriptKind.TS
    if (fileName.endsWith('.json')) return ts.ScriptKind.JSON
    return super.getScriptKind(fileName)
  }
}

self.onmessage = () => {
  initialize(
    (context, createData) => new WorkspaceTypeScriptWorker(context, createData)
  )
}
