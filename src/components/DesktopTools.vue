<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'

import type {
  AssistantCodeBlock,
  AssistantMessage,
  DesktopSettings,
  DesktopSettingsUpdate,
  EnvironmentVariable,
} from '../../types/desktop'
import { desktopAPI } from '../lib/desktop'

const props = defineProps<{ code: string }>()
const emit = defineEmits<{ (event: 'insert-code', code: string): void }>()

type Tab = 'environment' | 'assistant'
type Feedback = { text: string; tone: 'info' | 'success' | 'error' }
type AssistantDraft = DesktopSettingsUpdate['assistant']
type ChatEntry = AssistantMessage & {
  id: string
  codeBlocks?: AssistantCodeBlock[]
  includedCode?: boolean
}

const componentId = useId()
const environmentTab = ref<HTMLButtonElement | null>(null)
const assistantTab = ref<HTMLButtonElement | null>(null)
const addButton = ref<HTMLButtonElement | null>(null)
const promptInput = ref<HTMLTextAreaElement | null>(null)
const activeTab = ref<Tab>('environment')
const loading = ref(true)
const loadError = ref('')
const saved = ref<DesktopSettings | null>(null)
const environmentDraft = ref<EnvironmentVariable[]>([])
const assistantDraft = ref<AssistantDraft>({
  endpoint: '',
  model: '',
  timeoutMs: 60000,
})
const apiKey = ref('')
const clearApiKey = ref(false)
const saving = ref<Tab | null>(null)
const environmentFeedback = ref<Feedback | null>(null)
const assistantFeedback = ref<Feedback | null>(null)
const prompt = ref('')
const includeCurrentCode = ref(false)
const conversation = ref<ChatEntry[]>([])
const history = ref<AssistantMessage[]>([])
const chatFeedback = ref<Feedback | null>(null)
const activeRequestId = ref<string | null>(null)
const cancelling = ref(false)
const appliedBlock = ref('')
const inFlightRequests = new Set<string>()
let disposed = false
let sequence = 0

function uniqueId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++sequence}`
}

function cloneEnvironment(variables: EnvironmentVariable[]) {
  return variables.map((variable) => ({ ...variable }))
}

function configuration(settings: DesktopSettings['assistant']): AssistantDraft {
  return {
    endpoint: settings.endpoint,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message
    ? `${fallback} ${error.message}`
    : fallback
}

async function loadSettings() {
  loading.value = true
  loadError.value = ''
  try {
    const settings = await desktopAPI.getDesktopSettings()
    if (disposed) return
    saved.value = settings
    environmentDraft.value = cloneEnvironment(settings.environment)
    assistantDraft.value = configuration(settings.assistant)
    apiKey.value = ''
    clearApiKey.value = false
  } catch (error) {
    if (!disposed) {
      loadError.value = errorMessage(
        error,
        'Your settings could not be loaded. Please try again.'
      )
    }
  } finally {
    if (!disposed) loading.value = false
  }
}

const environmentDirty = computed(
  () =>
    saved.value !== null &&
    JSON.stringify(environmentDraft.value) !==
      JSON.stringify(saved.value.environment)
)
const assistantDirty = computed(
  () =>
    saved.value !== null &&
    (JSON.stringify(assistantDraft.value) !==
      JSON.stringify(configuration(saved.value.assistant)) ||
      apiKey.value.length > 0 ||
      clearApiKey.value)
)
const enabledCount = computed(
  () => environmentDraft.value.filter((variable) => variable.enabled).length
)
const formDisabled = computed(
  () => loading.value || !saved.value || saving.value !== null
)
const busy = computed(() => activeRequestId.value !== null || cancelling.value)

const environmentErrors = computed(() => {
  const names = new Map<string, number>()
  for (const variable of environmentDraft.value) {
    const name = variable.name.trim().toUpperCase()
    if (name) names.set(name, (names.get(name) ?? 0) + 1)
  }
  return environmentDraft.value.map((variable) => {
    if (!variable.name) return 'Give this variable a name.'
    if (variable.name.length > 256)
      return 'Use a name with up to 256 characters.'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) {
      return 'Use letters, numbers and underscores; start with a letter or underscore.'
    }
    if ((names.get(variable.name.toUpperCase()) ?? 0) > 1) {
      return 'Use a unique name. Names are compared without case for portability.'
    }
    if (variable.value.includes('\0'))
      return 'Values cannot contain a null character.'
    if (variable.value.length > 32768)
      return 'Use a value with up to 32,768 characters.'
    return ''
  })
})
const environmentInvalid = computed(() => environmentErrors.value.some(Boolean))

function endpointError(endpoint: string) {
  if (endpoint.length > 2048)
    return 'Use a base URL with up to 2,048 characters.'
  if (!endpoint.trim())
    return 'Enter the base URL of an OpenAI-compatible provider.'
  try {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return 'Use a complete http:// or https:// URL.'
    }
    if (url.username || url.password)
      return 'Keep credentials in the API key field, outside the URL.'
    if (url.search || url.hash)
      return 'Use a base URL without a query string or fragment.'
  } catch {
    return 'Use a complete URL, such as http://localhost:11434/v1.'
  }
  return ''
}

const assistantErrors = computed(() => ({
  endpoint: endpointError(assistantDraft.value.endpoint),
  model: !assistantDraft.value.model.trim()
    ? 'Enter the model name offered by your provider.'
    : assistantDraft.value.model.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(assistantDraft.value.model)
      ? 'Use a model ID with up to 200 characters and no control characters.'
      : '',
  timeoutMs:
    Number.isInteger(assistantDraft.value.timeoutMs) &&
    assistantDraft.value.timeoutMs >= 1000 &&
    assistantDraft.value.timeoutMs <= 180000
      ? ''
      : 'Choose a whole number from 1,000 to 180,000 milliseconds.',
}))
const assistantInvalid = computed(() =>
  Object.values(assistantErrors.value).some(Boolean)
)
const assistantConfigured = computed(
  () =>
    !!saved.value &&
    !endpointError(saved.value.assistant.endpoint) &&
    !!saved.value.assistant.model.trim()
)
const savedProvider = computed(
  () => saved.value?.assistant.endpoint || 'your saved provider'
)
const changesCredentialOrigin = computed(() => {
  if (!saved.value?.assistant.hasApiKey || clearApiKey.value || apiKey.value)
    return false
  try {
    return (
      new URL(assistantDraft.value.endpoint).origin !==
      new URL(saved.value.assistant.endpoint).origin
    )
  } catch {
    return false
  }
})
const requestSizeError = computed(() => {
  if (prompt.value.trim().length > 32000)
    return 'Keep your prompt within 32,000 characters.'
  if (includeCurrentCode.value && props.code.length > 300000)
    return 'Editor code exceeds 300,000 characters. Turn off the code attachment or shorten the code before sending.'
  return ''
})

// Keep complete recent turns, excluding oversized answers and their prompts.
function recentHistory(messages: AssistantMessage[]): AssistantMessage[] {
  const result: AssistantMessage[] = []
  let size = 0
  for (
    let index = messages.length - 2;
    index >= 0 && result.length < 12;
    index -= 2
  ) {
    const pair = messages.slice(index, index + 2)
    if (pair.some((message) => message.content.length > 64000)) continue
    const pairSize = pair.reduce(
      (total, message) => total + message.content.length,
      0
    )
    if (size + pairSize > 400000) break
    result.unshift(...pair.map((message) => ({ ...message })))
    size += pairSize
  }
  return result
}

async function addVariable() {
  if (environmentDraft.value.length >= 200) return
  const variable = { id: uniqueId(), name: '', value: '', enabled: true }
  environmentDraft.value.push(variable)
  environmentFeedback.value = null
  await nextTick()
  document.getElementById(`${componentId}-name-${variable.id}`)?.focus()
}

async function removeVariable(index: number) {
  environmentDraft.value.splice(index, 1)
  environmentFeedback.value = {
    text: 'Variable removed from this draft. Save to confirm the removal.',
    tone: 'info',
  }
  await nextTick()
  const next =
    environmentDraft.value[Math.min(index, environmentDraft.value.length - 1)]
  if (next) document.getElementById(`${componentId}-name-${next.id}`)?.focus()
  else addButton.value?.focus()
}

function resetEnvironment() {
  if (!saved.value) return
  environmentDraft.value = cloneEnvironment(saved.value.environment)
  environmentFeedback.value = {
    text: 'Draft reset to your saved environment.',
    tone: 'info',
  }
}

function resetAssistant() {
  if (!saved.value) return
  assistantDraft.value = configuration(saved.value.assistant)
  apiKey.value = ''
  clearApiKey.value = false
  assistantFeedback.value = {
    text: 'Draft reset to your saved configuration.',
    tone: 'info',
  }
}

async function saveSettings(section: Tab) {
  if (!saved.value || formDisabled.value) return
  if (
    section === 'environment'
      ? environmentInvalid.value
      : assistantInvalid.value
  )
    return
  const feedback =
    section === 'environment' ? environmentFeedback : assistantFeedback
  const hasEnteredKey = section === 'assistant' && apiKey.value.length > 0
  // The bridge takes a complete update: never include the other tab's draft.
  const update: DesktopSettingsUpdate = {
    environment: cloneEnvironment(
      section === 'environment'
        ? environmentDraft.value
        : saved.value.environment
    ),
    assistant:
      section === 'assistant'
        ? {
            endpoint: assistantDraft.value.endpoint.trim(),
            model: assistantDraft.value.model.trim(),
            timeoutMs: assistantDraft.value.timeoutMs,
            ...(clearApiKey.value
              ? { clearApiKey: true }
              : apiKey.value
                ? { apiKey: apiKey.value }
                : {}),
          }
        : configuration(saved.value.assistant),
  }
  saving.value = section
  feedback.value = null
  try {
    const response = await desktopAPI.saveDesktopSettings(update)
    if (disposed) return
    if (response.success === false) {
      feedback.value = {
        text: `${response.error}${hasEnteredKey ? ' Re-enter the API key to retry; the password field has been cleared.' : ''}`,
        tone: 'error',
      }
      return
    }
    saved.value = response.settings
    if (section === 'environment') {
      environmentDraft.value = cloneEnvironment(response.settings.environment)
      feedback.value = {
        text: 'Environment saved. Changes are ready for your next run.',
        tone: 'success',
      }
    } else {
      assistantDraft.value = configuration(response.settings.assistant)
      clearApiKey.value = false
      feedback.value = {
        text: response.settings.assistant.credentialError
          ? `Configuration saved. ${response.settings.assistant.credentialError}`
          : 'AI configuration saved. New requests will use these settings.',
        tone: response.settings.assistant.credentialError ? 'error' : 'success',
      }
    }
  } catch (error) {
    if (!disposed) {
      feedback.value = {
        text:
          errorMessage(
            error,
            'Settings could not be saved. Your saved configuration has not been confirmed.'
          ) +
          (hasEnteredKey
            ? ' Re-enter the API key to retry; the password field has been cleared.'
            : ''),
        tone: 'error',
      }
    }
  } finally {
    if (section === 'assistant') apiKey.value = ''
    if (!disposed) saving.value = null
  }
}

function selectTab(tab: Tab) {
  activeTab.value = tab
}

function handleTabKey(event: KeyboardEvent) {
  let tab: Tab
  if (event.key === 'Home') tab = 'environment'
  else if (event.key === 'End') tab = 'assistant'
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    tab = activeTab.value === 'environment' ? 'assistant' : 'environment'
  } else return
  event.preventDefault()
  selectTab(tab)
  ;(tab === 'environment' ? environmentTab : assistantTab).value?.focus()
}

async function askAssistant() {
  const text = prompt.value.trim()
  if (
    !text ||
    busy.value ||
    !assistantConfigured.value ||
    !!requestSizeError.value ||
    loading.value ||
    saving.value
  )
    return
  const requestId = uniqueId()
  const requestHistory = recentHistory(history.value)
  const code = includeCurrentCode.value ? props.code : ''
  conversation.value.push({
    id: `${requestId}-user`,
    role: 'user',
    content: text,
    includedCode: includeCurrentCode.value,
  })
  prompt.value = ''
  chatFeedback.value = null
  activeRequestId.value = requestId
  inFlightRequests.add(requestId)
  try {
    const response = await desktopAPI.askAssistant({
      requestId,
      prompt: text,
      code,
      history: requestHistory,
    })
    if (disposed || activeRequestId.value !== requestId) return
    if (response.requestId !== requestId) {
      chatFeedback.value = {
        text: 'The provider returned an unexpected response. Please try again.',
        tone: 'error',
      }
      return
    }
    if (response.success === false) {
      chatFeedback.value = {
        text: response.error,
        tone: response.errorCode === 'cancelled' ? 'info' : 'error',
      }
      return
    }
    conversation.value.push({
      id: `${requestId}-assistant`,
      role: 'assistant',
      content: response.content,
      codeBlocks: response.codeBlocks,
    })
    history.value = recentHistory([
      ...requestHistory,
      { role: 'user', content: text },
      { role: 'assistant', content: response.content },
    ])
    chatFeedback.value = {
      text:
        response.content.length > 64000
          ? 'Response received. This large reply and its prompt will be left out of future chat history. Review any code before applying it.'
          : 'Response received. Review any code before applying it.',
      tone: 'success',
    }
  } catch (error) {
    if (!disposed && activeRequestId.value === requestId) {
      chatFeedback.value = {
        text: errorMessage(
          error,
          'The assistant could not respond. Please try again.'
        ),
        tone: 'error',
      }
    }
  } finally {
    inFlightRequests.delete(requestId)
    if (!disposed && activeRequestId.value === requestId)
      activeRequestId.value = null
  }
}

async function cancelAssistant() {
  const requestId = activeRequestId.value
  if (!requestId || cancelling.value) return
  // Invalidate immediately so a late response cannot be added after cancellation.
  activeRequestId.value = null
  cancelling.value = true
  chatFeedback.value = { text: 'Cancelling the request…', tone: 'info' }
  try {
    await desktopAPI.cancelAssistant(requestId)
    if (!disposed)
      chatFeedback.value = {
        text: 'Request cancelled. You can send another prompt.',
        tone: 'info',
      }
  } catch {
    if (!disposed)
      chatFeedback.value = {
        text: 'Stopped waiting for this response. Provider cancellation could not be confirmed.',
        tone: 'error',
      }
  } finally {
    if (!disposed) {
      cancelling.value = false
      if (activeTab.value === 'assistant') promptInput.value?.focus()
    }
  }
}

function clearConversation() {
  if (busy.value) return
  conversation.value = []
  history.value = []
  appliedBlock.value = ''
  chatFeedback.value = {
    text: 'Conversation cleared. The next request starts without chat history.',
    tone: 'info',
  }
  promptInput.value?.focus()
}

function applyCode(code: string, id: string) {
  emit('insert-code', code)
  appliedBlock.value = id
}

onMounted(loadSettings)
onBeforeUnmount(() => {
  disposed = true
  for (const requestId of inFlightRequests) {
    void desktopAPI.cancelAssistant(requestId).catch((): void => undefined)
  }
})
</script>

<template>
  <aside class="desktop-tools" aria-label="Desktop tools">
    <header class="tools-header">
      <div class="tools-heading">
        <span class="tools-mark" aria-hidden="true">&gt;_</span>
        <h2>Workspace tools</h2>
      </div>
      <span class="desktop-badge">DESKTOP</span>
    </header>

    <div
      class="tools-tabs"
      role="tablist"
      aria-label="Workspace tools"
      @keydown="handleTabKey"
    >
      <button
        :id="`${componentId}-environment-tab`"
        ref="environmentTab"
        type="button"
        role="tab"
        :aria-selected="activeTab === 'environment'"
        :aria-controls="`${componentId}-environment-panel`"
        :tabindex="activeTab === 'environment' ? 0 : -1"
        @click="selectTab('environment')"
      >
        <span aria-hidden="true" class="tab-symbol">{ }</span> Environment
        <span
          v-if="environmentDirty"
          class="draft-dot"
          aria-label="Unsaved changes"
        ></span>
      </button>
      <button
        :id="`${componentId}-assistant-tab`"
        ref="assistantTab"
        type="button"
        role="tab"
        :aria-selected="activeTab === 'assistant'"
        :aria-controls="`${componentId}-assistant-panel`"
        :tabindex="activeTab === 'assistant' ? 0 : -1"
        @click="selectTab('assistant')"
      >
        <span aria-hidden="true" class="tab-symbol">✧</span> AI assistant
        <span
          v-if="assistantDirty"
          class="draft-dot"
          aria-label="Unsaved changes"
        ></span>
      </button>
    </div>

    <div
      v-if="loading"
      class="connection-state"
      role="status"
      aria-live="polite"
    >
      <span class="status-dot"></span> Loading desktop settings…
    </div>
    <div
      v-else-if="loadError"
      class="connection-state connection-error"
      role="alert"
    >
      <p>{{ loadError }}</p>
      <button type="button" class="button secondary" @click="loadSettings">
        Try again
      </button>
    </div>

    <section
      v-show="activeTab === 'environment'"
      :id="`${componentId}-environment-panel`"
      role="tabpanel"
      :aria-labelledby="`${componentId}-environment-tab`"
      class="tool-panel"
      tabindex="0"
    >
      <form
        class="settings-form environment-form"
        @submit.prevent="saveSettings('environment')"
        @input="environmentFeedback = null"
      >
        <div class="section-heading">
          <div>
            <h3>Environment variables</h3>
            <p>Keep your run configuration close to your code.</p>
          </div>
          <span class="count-badge">{{ enabledCount }} active</span>
        </div>
        <p :id="`${componentId}-env-help`" class="help-text">
          Enabled variables are used on your next run. Changes stay in this
          draft until you save.
        </p>

        <fieldset
          :disabled="formDisabled"
          class="fields-reset"
          aria-label="Environment variables"
        >
          <div v-if="environmentDraft.length === 0" class="empty-state">
            <span class="empty-symbol" aria-hidden="true">{ }</span>
            <strong>A clean environment</strong>
            <p>
              Add a variable for API URLs, feature flags or other values your
              code needs.
            </p>
          </div>
          <div
            v-for="(variable, index) in environmentDraft"
            :key="variable.id"
            class="variable-card"
            :class="{ 'variable-disabled': !variable.enabled }"
          >
            <div class="variable-toolbar">
              <label class="checkbox-label toggle-label">
                <input
                  v-model="variable.enabled"
                  type="checkbox"
                  :aria-label="`Enable ${variable.name || `variable ${index + 1}`}`"
                />
                <span>{{ variable.enabled ? 'Enabled' : 'Disabled' }}</span>
              </label>
              <button
                type="button"
                class="text-button danger-button"
                :aria-label="`Remove ${variable.name || `variable ${index + 1}`}`"
                @click="removeVariable(index)"
              >
                Remove
              </button>
            </div>
            <label :for="`${componentId}-name-${variable.id}`">Name</label>
            <input
              :id="`${componentId}-name-${variable.id}`"
              v-model="variable.name"
              class="mono-input"
              type="text"
              placeholder="API_BASE_URL"
              autocomplete="off"
              autocapitalize="off"
              :spellcheck="false"
              :aria-invalid="!!environmentErrors[index]"
              :aria-describedby="`${componentId}-env-error-${variable.id}`"
            />
            <label :for="`${componentId}-value-${variable.id}`">Value</label>
            <textarea
              :id="`${componentId}-value-${variable.id}`"
              v-model="variable.value"
              class="mono-input variable-value"
              rows="2"
              placeholder="Enter a value"
              autocomplete="off"
              :spellcheck="false"
              :aria-label="`Value for ${variable.name || `variable ${index + 1}`}`"
            ></textarea>
            <p
              :id="`${componentId}-env-error-${variable.id}`"
              class="field-hint"
              :class="{ 'field-error': environmentErrors[index] }"
            >
              {{
                environmentErrors[index] ||
                (variable.enabled
                  ? 'Included in your saved environment.'
                  : 'Kept in settings, excluded from runs.')
              }}
            </p>
          </div>
          <button
            ref="addButton"
            type="button"
            class="button add-button"
            :disabled="environmentDraft.length >= 200"
            @click="addVariable"
          >
            <span aria-hidden="true">+</span> Add variable
          </button>
        </fieldset>

        <div class="save-area">
          <div
            class="draft-status"
            :class="{ 'has-changes': environmentDirty }"
          >
            <span class="status-dot"></span
            >{{
              !saved
                ? 'Settings are not loaded'
                : environmentDirty
                  ? 'Unsaved environment changes'
                  : 'Environment is up to date'
            }}
          </div>
          <div
            v-if="environmentFeedback"
            class="feedback"
            :class="environmentFeedback.tone"
            role="status"
            aria-live="polite"
          >
            {{ environmentFeedback.text }}
          </div>
          <p v-if="environmentInvalid" class="field-hint field-error">
            Resolve the variable hints before saving.
          </p>
          <div class="action-row">
            <button
              type="button"
              class="button secondary"
              :disabled="formDisabled || !environmentDirty"
              @click="resetEnvironment"
            >
              Reset draft
            </button>
            <button
              type="submit"
              class="button primary"
              :disabled="
                formDisabled || !environmentDirty || environmentInvalid
              "
            >
              {{ saving === 'environment' ? 'Saving…' : 'Save environment' }}
            </button>
          </div>
        </div>
      </form>
    </section>

    <section
      v-show="activeTab === 'assistant'"
      :id="`${componentId}-assistant-panel`"
      role="tabpanel"
      :aria-labelledby="`${componentId}-assistant-tab`"
      class="tool-panel assistant-panel"
      tabindex="0"
    >
      <details class="provider-settings" open>
        <summary>
          <span>Provider configuration</span
          ><span class="summary-badge">{{
            assistantDirty
              ? 'Unsaved'
              : assistantConfigured
                ? 'Configured'
                : 'Set up'
          }}</span>
        </summary>
        <form
          class="settings-form"
          @submit.prevent="saveSettings('assistant')"
          @input="assistantFeedback = null"
        >
          <p class="help-text">
            Connect an OpenAI-compatible API, including local providers. Local
            endpoints can work without an API key.
          </p>
          <fieldset
            :disabled="formDisabled || busy"
            class="fields-reset provider-fields"
            aria-label="AI provider settings"
          >
            <div class="field-group">
              <label :for="`${componentId}-endpoint`"
                >Provider endpoint
                <span class="label-note">Base URL</span></label
              >
              <input
                :id="`${componentId}-endpoint`"
                v-model="assistantDraft.endpoint"
                type="url"
                class="mono-input"
                placeholder="http://localhost:11434/v1"
                autocomplete="off"
                :spellcheck="false"
                :aria-invalid="assistantDirty && !!assistantErrors.endpoint"
                :aria-describedby="`${componentId}-endpoint-hint`"
              />
              <p
                :id="`${componentId}-endpoint-hint`"
                class="field-hint"
                :class="{
                  'field-error': assistantDirty && assistantErrors.endpoint,
                }"
              >
                {{
                  assistantDirty && assistantErrors.endpoint
                    ? assistantErrors.endpoint
                    : 'For example: https://api.openai.com/v1 or a local /v1 endpoint.'
                }}
              </p>
              <p
                v-if="changesCredentialOrigin"
                class="field-hint storage-warning"
                role="status"
              >
                Changing provider origin requires a replacement API key or
                explicit removal of the saved key before saving.
              </p>
            </div>
            <div class="field-group">
              <label :for="`${componentId}-model`">Model</label>
              <input
                :id="`${componentId}-model`"
                v-model="assistantDraft.model"
                type="text"
                class="mono-input"
                placeholder="Your provider’s model name"
                autocomplete="off"
                :spellcheck="false"
                :aria-invalid="assistantDirty && !!assistantErrors.model"
                :aria-describedby="`${componentId}-model-hint`"
              />
              <p
                :id="`${componentId}-model-hint`"
                class="field-hint"
                :class="{
                  'field-error': assistantDirty && assistantErrors.model,
                }"
              >
                {{
                  assistantDirty && assistantErrors.model
                    ? assistantErrors.model
                    : 'Use the exact model identifier available at this endpoint.'
                }}
              </p>
            </div>
            <div class="field-group">
              <label :for="`${componentId}-timeout`"
                >Request timeout
                <span class="label-note">milliseconds</span></label
              >
              <input
                :id="`${componentId}-timeout`"
                v-model.number="assistantDraft.timeoutMs"
                type="number"
                min="1000"
                max="180000"
                step="1"
                :aria-invalid="!!assistantErrors.timeoutMs"
                :aria-describedby="`${componentId}-timeout-hint`"
              />
              <p
                :id="`${componentId}-timeout-hint`"
                class="field-hint"
                :class="{ 'field-error': assistantErrors.timeoutMs }"
              >
                {{
                  assistantErrors.timeoutMs ||
                  '1,000–180,000 ms. Allow more time for local models.'
                }}
              </p>
            </div>
            <div class="credential-card">
              <div class="credential-heading">
                <label :for="`${componentId}-api-key`"
                  >API key <span class="label-note">optional</span></label
                ><span
                  class="credential-status"
                  :class="{ 'credential-saved': saved?.assistant.hasApiKey }"
                  >{{
                    saved?.assistant.hasApiKey ? 'Key saved' : 'No saved key'
                  }}</span
                >
              </div>
              <input
                :id="`${componentId}-api-key`"
                v-model="apiKey"
                type="password"
                autocomplete="new-password"
                :disabled="clearApiKey"
                :placeholder="
                  saved?.assistant.hasApiKey
                    ? 'Enter a replacement key'
                    : 'Enter an API key if required'
                "
                :aria-describedby="`${componentId}-key-hint`"
              />
              <p :id="`${componentId}-key-hint`" class="field-hint">
                Saved keys are never displayed. Leave blank to keep the saved
                key; the field clears after a save attempt.
              </p>
              <label
                v-if="saved?.assistant.hasApiKey"
                class="checkbox-label remove-key-label"
              >
                <input
                  v-model="clearApiKey"
                  type="checkbox"
                  @change="apiKey = ''"
                />
                Remove the saved API key on save
              </label>
              <p
                v-if="saved && !saved.assistant.secureStorageAvailable"
                class="field-hint storage-warning"
                role="status"
              >
                Secure credential storage is unavailable. You can still use a
                local provider that does not require a key.
              </p>
              <p
                v-if="saved?.assistant.credentialError"
                class="field-hint field-error"
                role="status"
              >
                {{ saved.assistant.credentialError }}
              </p>
            </div>
          </fieldset>
          <div class="save-area provider-save-area">
            <div
              class="draft-status"
              :class="{ 'has-changes': assistantDirty }"
            >
              <span class="status-dot"></span
              >{{
                assistantDirty
                  ? 'Unsaved AI configuration'
                  : 'Using saved AI configuration'
              }}
            </div>
            <div
              v-if="assistantFeedback"
              class="feedback"
              :class="assistantFeedback.tone"
              role="status"
              aria-live="polite"
            >
              {{ assistantFeedback.text }}
            </div>
            <div class="action-row">
              <button
                type="button"
                class="button secondary"
                :disabled="formDisabled || busy || !assistantDirty"
                @click="resetAssistant"
              >
                Reset draft
              </button>
              <button
                type="submit"
                class="button primary"
                :disabled="
                  formDisabled || busy || !assistantDirty || assistantInvalid
                "
              >
                {{ saving === 'assistant' ? 'Saving…' : 'Save configuration' }}
              </button>
            </div>
          </div>
        </form>
      </details>

      <div class="chat-section">
        <div class="section-heading">
          <div>
            <h3>Ask your assistant</h3>
            <p>Understand, debug or reshape your code.</p>
          </div>
          <button
            type="button"
            class="text-button"
            :disabled="busy || conversation.length === 0"
            @click="clearConversation"
          >
            Clear chat
          </button>
        </div>
        <div class="provider-disclosure" :id="`${componentId}-disclosure`">
          <span class="disclosure-title">What gets sent</span>
          <p>
            Your prompt and up to 12 previous chat messages are sent to your
            saved provider. Editor code is sent only when you enable it below.
            Previous replies may contain code.
          </p>
          <span class="provider-address">{{ savedProvider }}</span>
        </div>
        <p v-if="assistantDirty" class="draft-warning" role="status">
          You have unsaved configuration changes. Chat continues to use the
          saved endpoint and model{{
            saved?.assistant.model ? ` (${saved.assistant.model})` : ''
          }}
          until you save.
        </p>
        <p v-else-if="!assistantConfigured && !loading" class="help-text">
          Save an endpoint and model above to start a conversation. An API key
          is only needed if your provider requires one.
        </p>

        <div
          class="conversation"
          role="log"
          aria-label="Assistant conversation"
          aria-live="polite"
          aria-relevant="additions"
        >
          <div v-if="conversation.length === 0" class="chat-empty">
            <span aria-hidden="true">✧</span>
            <p>A second pair of eyes for your workspace.</p>
            <span>Ask a question below to get started.</span>
          </div>
          <article
            v-for="message in conversation"
            :key="message.id"
            class="chat-message"
            :class="message.role"
            :aria-label="
              message.role === 'user' ? 'Your message' : 'Assistant response'
            "
          >
            <div class="message-heading">
              <strong>{{
                message.role === 'user' ? 'You' : 'Assistant'
              }}</strong
              ><span v-if="message.role === 'user'" class="message-context">{{
                message.includedCode
                  ? 'Editor code included'
                  : 'No editor attachment'
              }}</span>
            </div>
            <pre class="message-content">{{ message.content }}</pre>
            <div
              v-for="(block, index) in message.codeBlocks"
              :key="`${message.id}-${index}`"
              class="response-code"
            >
              <div class="code-heading">
                <span>{{ block.language || 'Code' }}</span
                ><button
                  type="button"
                  class="button apply-button"
                  :aria-label="`Apply code block ${index + 1} to the editor`"
                  @click="applyCode(block.code, `${message.id}-${index}`)"
                >
                  {{
                    appliedBlock === `${message.id}-${index}`
                      ? 'Applied · Apply again'
                      : 'Apply code'
                  }}
                </button>
              </div>
              <pre
                tabindex="0"
                :aria-label="`Code block ${index + 1}`"
              ><code>{{ block.code }}</code></pre>
            </div>
          </article>
        </div>
        <p v-if="appliedBlock" class="field-hint applied-status" role="status">
          Code sent to the editor. Review it before running.
        </p>
        <div
          v-if="activeRequestId"
          class="pending-state"
          role="status"
          aria-live="polite"
        >
          <span class="status-dot pulse"></span> Waiting for your provider…
        </div>
        <div
          v-if="chatFeedback"
          class="feedback"
          :class="chatFeedback.tone"
          role="status"
          aria-live="polite"
        >
          {{ chatFeedback.text }}
        </div>

        <form class="prompt-form" @submit.prevent="askAssistant">
          <label :for="`${componentId}-prompt`">Message</label>
          <textarea
            :id="`${componentId}-prompt`"
            ref="promptInput"
            v-model="prompt"
            rows="4"
            maxlength="32000"
            placeholder="What would you like help with?"
            :disabled="loading || !saved || busy"
            :aria-invalid="!!requestSizeError"
            :aria-describedby="`${componentId}-disclosure ${componentId}-apply-help ${componentId}-request-size`"
          ></textarea>
          <label class="checkbox-label include-code-label"
            ><input
              v-model="includeCurrentCode"
              type="checkbox"
              :disabled="busy"
            />
            Include current editor code
            <span v-if="includeCurrentCode" class="code-size"
              >{{ code.length.toLocaleString() }} chars</span
            ></label
          >
          <p
            :id="`${componentId}-request-size`"
            class="field-hint"
            :class="{ 'field-error': requestSizeError }"
            role="status"
          >
            {{
              requestSizeError ||
              `${prompt.length.toLocaleString()} / 32,000 prompt characters. Large replies are left out of future history.`
            }}
          </p>
          <div class="prompt-actions">
            <span :id="`${componentId}-apply-help`" class="field-hint"
              >Apply code sends it to the editor. You choose when to run.</span
            ><button
              v-if="activeRequestId || cancelling"
              type="button"
              class="button secondary"
              :disabled="cancelling"
              @click="cancelAssistant"
            >
              {{ cancelling ? 'Cancelling…' : 'Cancel request' }}</button
            ><button
              v-else
              type="submit"
              class="button primary"
              :disabled="
                !prompt.trim() ||
                !assistantConfigured ||
                !!requestSizeError ||
                loading ||
                saving !== null
              "
            >
              Send prompt <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </div>
    </section>
    <footer class="tools-footer">
      <span class="footer-dot" aria-hidden="true"></span> Your workspace. Your
      configuration.
    </footer>
  </aside>
</template>

<style scoped>
.desktop-tools {
  --tools-bg: #21222c;
  --tools-surface: #282a36;
  --tools-border: #3b3d50;
  --tools-text: #f2f2f8;
  --tools-muted: #b0b2c7;
  --tools-accent: #bd93f9;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--tools-text);
  background: var(--tools-bg);
  border-left: 1px solid var(--tools-border);
  font:
    12px/1.55 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  color-scheme: dark;
}
.desktop-tools *,
.desktop-tools *::before,
.desktop-tools *::after {
  box-sizing: border-box;
}
.tools-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 17px 18px 15px;
}
.tools-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.tools-mark {
  color: var(--tools-accent);
  font:
    700 17px/1 Consolas,
    monospace;
}
h2,
h3,
p {
  margin: 0;
}
h2 {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.15px;
}
h3 {
  font-size: 13px;
  font-weight: 600;
}
.desktop-badge {
  color: #a0a4bc;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1.4px;
}
.tools-tabs {
  display: flex;
  flex: 0 0 auto;
  border-bottom: 1px solid var(--tools-border);
  padding: 0 12px;
  gap: 8px;
}
.desktop-tools button {
  color: var(--tools-text);
  opacity: 1;
  cursor: pointer;
  font: inherit;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    color 0.15s;
}
.desktop-tools button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.tools-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 10px 8px 12px;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--tools-muted);
  white-space: nowrap;
}
.tools-tabs button[aria-selected='true'] {
  border-bottom-color: var(--tools-accent);
  color: var(--tools-text);
}
.tools-tabs button:hover {
  color: #fff;
  background: #ffffff05;
}
.tab-symbol {
  color: var(--tools-accent);
  font-family: Consolas, monospace;
  font-size: 14px;
}
.draft-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #f1fa8c;
}
.tool-panel {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: #55566c transparent;
}
.settings-form {
  padding: 18px;
}
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.section-heading p {
  margin-top: 4px;
  font-size: 11px;
  color: var(--tools-muted);
}
.count-badge,
.summary-badge {
  flex-shrink: 0;
  border: 1px solid #bd93f930;
  border-radius: 5px;
  background: #bd93f90a;
  color: #d1b4fc;
  padding: 2px 6px;
  font-size: 10px;
}
.help-text {
  color: var(--tools-muted);
  font-size: 11px;
  line-height: 1.65;
  margin-bottom: 16px;
}
.fields-reset {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.variable-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid var(--tools-border);
  border-radius: 8px;
  background: var(--tools-surface);
}
.variable-disabled {
  border-style: dashed;
  background: #262732;
}
.variable-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.desktop-tools label {
  display: block;
  font-size: 11px;
  font-weight: 500;
  color: #e2e2ef;
}
.desktop-tools input:not([type='checkbox']),
.desktop-tools textarea {
  display: block;
  width: 100%;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid #45475d;
  border-radius: 5px;
  outline: none;
  background: #1c1d27;
  color: var(--tools-text);
  font: inherit;
  line-height: 1.5;
}
.desktop-tools input::placeholder,
.desktop-tools textarea::placeholder {
  color: #8d8fa7;
}
.desktop-tools input:disabled,
.desktop-tools textarea:disabled {
  opacity: 0.55;
}
.desktop-tools input[aria-invalid='true'],
.desktop-tools textarea[aria-invalid='true'] {
  border-color: #ef839b;
}
.desktop-tools textarea {
  resize: vertical;
  min-height: 50px;
}
.desktop-tools .mono-input,
.message-content,
.response-code pre {
  font-family: 'Cascadia Code', Consolas, 'Liberation Mono', monospace;
  font-size: 11px;
}
.desktop-tools .variable-value {
  min-height: 54px;
}
.desktop-tools :is(button, input, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--tools-accent);
  outline-offset: 3px;
}
.desktop-tools :is(input:not([type='checkbox']), textarea):focus-visible {
  outline-offset: 1px;
  border-color: var(--tools-accent);
}
.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.desktop-tools input[type='checkbox'] {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--tools-accent);
  cursor: pointer;
}
.toggle-label {
  color: var(--tools-muted) !important;
  font-size: 10px !important;
}
.text-button {
  border: 0;
  background: transparent;
  padding: 3px 1px;
  color: #c8b5eb !important;
  font-size: 10px !important;
}
.text-button:hover:not(:disabled) {
  color: #e9dcff !important;
  text-decoration: underline;
}
.danger-button {
  color: #f99bb1 !important;
}
.danger-button:hover:not(:disabled) {
  color: #ffc6d4 !important;
}
.field-hint {
  color: var(--tools-muted);
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.field-error {
  color: #ff9caf;
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 33px;
  padding: 7px 11px;
  border: 1px solid var(--tools-border);
  border-radius: 5px;
  font-size: 11px !important;
  font-weight: 500 !important;
  line-height: 1.35 !important;
}
.primary {
  color: #21182f !important;
  background: #bd93f9;
  border-color: #bd93f9;
}
.primary:hover:not(:disabled) {
  background: #cdaafe;
  border-color: #cdaafe;
}
.secondary {
  background: #2b2d3a;
}
.secondary:hover:not(:disabled) {
  background: #36384a;
  border-color: #63657e;
}
.add-button {
  width: 100%;
  border-style: dashed;
  color: #d2bcf2 !important;
  background: #bd93f908;
}
.add-button:hover:not(:disabled) {
  background: #bd93f915;
  border-color: #9573c9;
}
.add-button span {
  font-size: 17px;
  line-height: 1;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  padding: 32px 16px;
  margin-bottom: 14px;
  border: 1px dashed var(--tools-border);
  border-radius: 8px;
}
.empty-symbol {
  font:
    24px/1.5 Consolas,
    monospace;
  color: #8d75b3;
}
.empty-state strong {
  font-size: 12px;
  font-weight: 500;
}
.empty-state p {
  color: var(--tools-muted);
  font-size: 11px;
  max-width: 250px;
}
.save-area {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--tools-border);
}
.draft-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: var(--tools-muted);
}
.status-dot {
  display: inline-block;
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #7cae97;
}
.has-changes {
  color: #e7d397;
}
.has-changes .status-dot {
  background: #e7d397;
}
.action-row {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.feedback {
  border: 1px solid #44475a;
  border-radius: 5px;
  background: #282a36;
  padding: 9px 11px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.feedback.success {
  color: #a5e9bd;
  border-color: #50fa7b30;
  background: #50fa7b07;
}
.feedback.error {
  color: #ffb1bf;
  border-color: #ff6e8a40;
  background: #ff6e8a08;
}
.connection-state {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  color: var(--tools-muted);
  border-bottom: 1px solid var(--tools-border);
  font-size: 11px;
}
.connection-error {
  flex-direction: column;
  align-items: flex-start;
  color: #ffb1bf;
}
.provider-settings {
  margin: 14px 14px 0;
  border: 1px solid var(--tools-border);
  border-radius: 8px;
  background: #252631;
}
.provider-settings summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  cursor: pointer;
  padding: 12px;
  list-style: none;
  font-size: 11px;
  font-weight: 600;
}
.provider-settings summary::-webkit-details-marker {
  display: none;
}
.provider-settings summary > span:first-child::before {
  display: inline-block;
  margin-right: 8px;
  content: '›';
  color: var(--tools-accent);
  transform: rotate(0deg);
}
.provider-settings[open] summary > span:first-child::before {
  transform: rotate(90deg);
}
.provider-settings .settings-form {
  padding: 2px 12px 14px;
}
.provider-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.label-note {
  color: var(--tools-muted);
  font-size: 10px;
  font-weight: 400;
  margin-left: 4px;
}
.credential-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--tools-border);
}
.credential-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.credential-status {
  font-size: 9px;
  color: var(--tools-muted);
}
.credential-saved {
  color: #a5e9bd;
}
.remove-key-label {
  margin-top: 4px;
  font-size: 10px !important;
  color: #f1b2c1 !important;
}
.storage-warning {
  color: #e7d397;
}
.provider-save-area {
  margin-top: 14px;
}
.chat-section {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 20px 18px;
}
.chat-section > .section-heading {
  margin: 0;
}
.provider-disclosure {
  padding: 11px 12px;
  border: 1px solid #8be9fd25;
  border-radius: 6px;
  background: #8be9fd05;
  color: #b6bbcf;
  font-size: 10px;
  line-height: 1.65;
}
.disclosure-title {
  display: block;
  color: #b0e1ed;
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 4px;
}
.provider-address {
  display: block;
  color: #d5d8e8;
  font-family: Consolas, monospace;
  margin-top: 7px;
  overflow-wrap: anywhere;
}
.draft-warning {
  padding: 9px 11px;
  border-left: 2px solid #e7d397;
  color: #e7d397;
  background: #e7d39706;
  font-size: 10px;
}
.conversation {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 18px 4px 22px;
  text-align: center;
  color: var(--tools-muted);
  font-size: 10px;
}
.chat-empty > span:first-child {
  color: var(--tools-accent);
  font-size: 27px;
  margin-bottom: 4px;
}
.chat-empty p {
  color: #d5d4e3;
  font-size: 11px;
}
.chat-message {
  padding: 12px;
  border: 1px solid var(--tools-border);
  border-radius: 7px;
  min-width: 0;
  background: var(--tools-surface);
}
.chat-message.user {
  background: #bd93f908;
  border-color: #bd93f925;
}
.message-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.message-heading strong {
  font-size: 10px;
  font-weight: 600;
  color: #d3b5ff;
}
.assistant .message-heading strong {
  color: #8be9fd;
}
.message-context {
  color: var(--tools-muted);
  font-size: 9px;
}
.message-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
  margin: 0;
  color: #e2e2ed;
}
.response-code {
  margin-top: 12px;
  border: 1px solid #44475a;
  border-radius: 6px;
  overflow: hidden;
}
.code-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  background: #303240;
}
.code-heading > span {
  color: #c9c5db;
  font:
    10px/1.5 Consolas,
    monospace;
  overflow-wrap: anywhere;
}
.apply-button {
  min-height: 26px;
  padding: 5px 8px;
  color: #d8bfff !important;
  border-color: #bd93f955;
  background: #bd93f90c;
  font-size: 10px !important;
}
.apply-button:hover {
  background: #bd93f922;
}
.response-code pre {
  max-height: 300px;
  padding: 12px;
  margin: 0;
  background: #191a23;
  overflow: auto;
  line-height: 1.7;
  white-space: pre;
  tab-size: 2;
}
.response-code code {
  font: inherit;
  color: #d5e9dc;
}
.applied-status {
  color: #a5e9bd;
}
.pending-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #d7c3f6;
  font-size: 11px;
}
.pulse {
  background: var(--tools-accent);
  animation: tools-pulse 1.5s ease-in-out infinite;
}
.prompt-form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.prompt-form textarea {
  min-height: 95px;
  max-height: 350px;
  font-size: 12px;
}
.include-code-label {
  flex-wrap: wrap;
  font-size: 10px !important;
  color: #c8c8dc !important;
}
.code-size {
  margin-left: auto;
  color: var(--tools-muted);
  font:
    9px/1.5 Consolas,
    monospace;
}
.prompt-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 3px;
}
.prompt-actions .field-hint {
  max-width: 185px;
}
.prompt-actions .button {
  flex-shrink: 0;
}
.tools-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  padding: 9px 18px;
  border-top: 1px solid var(--tools-border);
  color: #9194ac;
  font-size: 9px;
}
.footer-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #7d689e;
}
@keyframes tools-pulse {
  50% {
    opacity: 0.3;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pulse {
    animation: none;
  }
  .desktop-tools button {
    transition: none;
  }
}
@media (max-width: 520px) {
  .tools-header {
    padding: 13px 12px;
  }
  .settings-form,
  .chat-section {
    padding: 14px 12px;
  }
  .tools-tabs {
    padding: 0 7px;
    gap: 3px;
  }
  .tools-tabs button {
    padding-inline: 7px;
    font-size: 11px;
  }
  .provider-settings {
    margin-inline: 10px;
  }
  .prompt-actions {
    flex-wrap: wrap;
  }
  .prompt-actions .field-hint {
    max-width: none;
    flex-basis: 100%;
  }
  .prompt-actions .button {
    margin-left: auto;
  }
  .desktop-badge {
    font-size: 7px;
    letter-spacing: 1px;
  }
  .message-heading {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>
