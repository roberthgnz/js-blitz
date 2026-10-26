import type { DesktopToolsBridge } from './desktop'

export type WindowState = {
  width: number
  height: number
  x: number
  y: number
}

export type OutputType = 'log' | 'info' | 'warn' | 'error' | 'result'

export type Output = {
  type: OutputType
  value: string[]
  line?: number
}

export interface ExecuteResponse {
  success: boolean
  output: Output[]
  error?: string
}

export interface ExecuteRequest {
  code: string
  runId: string
  language: 'javascript' | 'typescript'
  env?: Record<string, string>
  timeoutMs?: number
}

export interface TypeDefinition {
  path: string
  content: string
}

export interface InstalledPackage {
  name: string
  version: string
}

export interface DesktopEventMap {
  'set-theme': [name: string]
  'execution-output': [event: { runId: string; output: Output }]
  'package-installation-started': []
  'package-installation-finished': []
  'code-execution-started': []
  'code-execution-finished': []
}

export interface DesktopAPI extends DesktopToolsBridge {
  on<Event extends keyof DesktopEventMap>(
    event: Event,
    callback: (...args: DesktopEventMap[Event]) => void
  ): () => void
  executeCode(request: ExecuteRequest): Promise<ExecuteResponse>
  cancelExecution(runId: string): Promise<void>
  listPackages(): Promise<InstalledPackage[]>
  installPackage(name: string): Promise<void>
  getTypeDefinitions(): Promise<TypeDefinition[]>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  showContextMenu(): Promise<void>
}

type ExecuteCodeStatus =
  | 'package-installation-started'
  | 'package-installation-finished'
  | 'code-execution-started'
  | 'code-execution-finished'

export type ExecuteCodeCallback = (status: {
  status: ExecuteCodeStatus
}) => void
