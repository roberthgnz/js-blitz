export type WindowState = {
  width: number
  height: number
  x: number
  y: number
}

export type OutputType = 'log' | 'info' | 'warn' | 'error'

export type Output = {
  type: OutputType
  value: any
}

export interface ExecuteResponse {
  success: boolean
  output: Output[]
  error?: string
}

type ExecuteCodeStatus =
  | 'package-installation-started'
  | 'package-installation-finished'
  | 'code-execution-started'
  | 'code-execution-finished'

export type ExecuteCodeCallback = (status: {
  status: ExecuteCodeStatus
}) => void
