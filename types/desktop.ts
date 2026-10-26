/** Public desktop settings. AI credentials are deliberately never returned. */
export interface EnvironmentVariable {
  id: string
  name: string
  value: string
  enabled: boolean
}

export interface AssistantSettings {
  /** OpenAI-compatible base URL (for example http://localhost:11434/v1). */
  endpoint: string
  model: string
  timeoutMs: number
  hasApiKey: boolean
  secureStorageAvailable: boolean
  credentialError?: string
}

export interface DesktopSettings {
  environment: EnvironmentVariable[]
  assistant: AssistantSettings
}

export interface DesktopSettingsUpdate {
  environment: EnvironmentVariable[]
  assistant: {
    endpoint: string
    model: string
    timeoutMs: number
    /** Omit to retain the saved credential. Empty strings also retain it. */
    apiKey?: string
    /** Explicitly remove the saved credential. */
    clearApiKey?: boolean
  }
}

export type SaveDesktopSettingsResponse =
  | { success: true; settings: DesktopSettings }
  | { success: false; error: string }

export interface AssistantMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantRequest {
  /** Unique per pending request; also passed to cancelAssistant. */
  requestId: string
  prompt: string
  code: string
  history?: AssistantMessage[]
}

export interface AssistantCodeBlock {
  language: string
  code: string
}

export type AssistantErrorCode =
  | 'invalid-request'
  | 'not-configured'
  | 'credentials'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'provider'
  | 'invalid-response'

export type AssistantResponse =
  | {
      success: true
      requestId: string
      content: string
      codeBlocks: AssistantCodeBlock[]
    }
  | {
      success: false
      requestId: string
      error: string
      errorCode: AssistantErrorCode
    }

/** Settings and assistant methods exposed by the native desktop bridge. */
export interface DesktopToolsBridge {
  getDesktopSettings(): Promise<DesktopSettings>
  saveDesktopSettings(
    settings: DesktopSettingsUpdate
  ): Promise<SaveDesktopSettingsResponse>
  askAssistant(request: AssistantRequest): Promise<AssistantResponse>
  cancelAssistant(requestId: string): Promise<boolean>
}
