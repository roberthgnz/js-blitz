import { compileBrowserCode, type BrowserCompileRequest } from './browser-compiler'

const compiler = self as unknown as {
  onmessage: ((event: MessageEvent<BrowserCompileRequest>) => void) | null
  postMessage(message: unknown): void
}

compiler.onmessage = ({ data }) => {
  try {
    compiler.postMessage({ success: true, code: compileBrowserCode(data) })
  } catch (error) {
    compiler.postMessage({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
