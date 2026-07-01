import { net } from 'electron'
import { getSettings } from './settings'

export interface AzureConfig {
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamHandlers {
  onToken: (text: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

export function getAzureConfig(): AzureConfig | null {
  const s = getSettings()
  if (!s.azureEndpoint || !s.azureApiKey || !s.azureDeployment) return null
  return {
    endpoint: s.azureEndpoint,
    apiKey: s.azureApiKey,
    deployment: s.azureDeployment,
    apiVersion: s.azureApiVersion
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

/** Honour Azure's Retry-After header (seconds) or retry-after-ms; fall back otherwise. */
function retryAfterMs(response: Response, fallbackMs: number): number {
  const ms = response.headers.get('retry-after-ms')
  if (ms && Number.isFinite(Number(ms))) return Number(ms)
  const secs = response.headers.get('retry-after')
  if (secs && Number.isFinite(Number(secs))) return Number(secs) * 1000
  return fallbackMs
}

async function pumpStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') {
        handlers.onDone()
        return
      }
      try {
        const json = JSON.parse(data)
        const token: unknown = json?.choices?.[0]?.delta?.content
        if (typeof token === 'string' && token.length > 0) {
          handlers.onToken(token)
        }
      } catch {
        // Ignore keepalive / non-JSON lines.
      }
    }
  }
  handlers.onDone()
}

function describeError(status: number, detail: string): string {
  if (status === 429) {
    return "Rate limited by Azure (429): this deployment's tokens-per-minute quota is exhausted. Wait a few seconds before asking again, or use a higher-quota deployment."
  }
  if (status === 401 || status === 403) {
    return `Azure auth failed (${status}): check the API key matches this endpoint and deployment.`
  }
  if (status === 404) {
    return `Deployment not found (404): check the deployment name and api-version. ${detail}`.trim()
  }
  return `AI request failed (${status}) ${detail}`.trim()
}

/**
 * Stream a chat completion from Azure OpenAI.
 * Uses Electron's net.fetch (Chromium network stack) so it honours the system
 * proxy and certificate store — important behind corporate TLS inspection.
 *
 * Resilience for continuous use:
 *  - Automatically retries on HTTP 429 (rate limit) honouring Retry-After, so
 *    rapid back-to-back questions recover instead of failing.
 *  - Falls back gracefully for newer models that require `max_completion_tokens`
 *    or reject a custom `temperature` (o-series / gpt-5 family).
 */
export async function streamChat(
  config: AzureConfig,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const base = config.endpoint.replace(/\/+$/, '')
  const url = `${base}/openai/deployments/${config.deployment}/chat/completions?api-version=${config.apiVersion}`

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    // Low temperature keeps answers grounded and reduces hallucination/
    // fabrication. A 400-fallback below drops this for models that reject it.
    temperature: 0.2,
    max_completion_tokens: 700
  }

  const MAX_RATE_LIMIT_RETRIES = 2
  let rateLimitRetries = 0
  let droppedTemperature = false
  let swappedTokenParam = false

  try {
    for (;;) {
      const response = await net.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': config.apiKey
        },
        body: JSON.stringify(body),
        signal
      })

      if (response.ok && response.body) {
        await pumpStream(response.body, handlers)
        return
      }

      const status = response.status
      const detail = (await response.text().catch(() => '')).slice(0, 400)

      // Rate limited: back off briefly and retry so continuous asking recovers.
      if (status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries += 1
        const waitMs = Math.min(retryAfterMs(response, 2500 * rateLimitRetries), 10000)
        await delay(waitMs, signal)
        continue
      }

      // Newer models require max_completion_tokens or reject custom temperature.
      if (status === 400 && !droppedTemperature && /temperature/i.test(detail)) {
        droppedTemperature = true
        delete body.temperature
        continue
      }
      if (status === 400 && !swappedTokenParam && /max_completion_tokens|max_tokens/i.test(detail)) {
        swappedTokenParam = true
        if ('max_completion_tokens' in body) {
          body.max_tokens = body.max_completion_tokens
          delete body.max_completion_tokens
        } else if ('max_tokens' in body) {
          body.max_completion_tokens = body.max_tokens
          delete body.max_tokens
        }
        continue
      }

      throw new Error(describeError(status, detail))
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return
    handlers.onError(error as Error)
  }
}
