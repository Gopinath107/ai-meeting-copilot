import { net } from 'electron'
import { getSettings } from './settings'
import {
  AzureStreamError,
  consumeAzureChatStream,
  type AzureStreamCompletion
} from './azureStream'

export type { AzureStreamCompletion, AzureStreamUsage } from './azureStream'

export interface AzureConfig {
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | {
            type: 'image_url'
            image_url: { url: string; detail?: 'low' | 'auto' | 'high' }
          }
      >
}

export interface StreamHandlers {
  onToken: (text: string) => void
  onDone: (completion: AzureStreamCompletion) => void
  onError: (error: Error) => void
}

export interface StreamChatOptions {
  /** Maximum output budget for this request. Defaults to 700 for compatibility. */
  maxOutputTokens?: number
  /** Maximum transient retries after the first attempt. Clamped to 0-5. */
  maxRetries?: number
  /** Exponential-backoff base. Primarily exposed so callers can tune UX latency. */
  retryBaseDelayMs?: number
  /** Hard bound for either server-directed or client-generated retry delays. */
  retryMaxDelayMs?: number
  /** Request streamed token usage when the configured Azure API version supports it. */
  includeUsage?: boolean
  /** @internal Deterministic jitter source for tests. */
  random?: () => number
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
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value as number)))
}

export function serverRetryAfterMs(response: Response, now = Date.now()): number | undefined {
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const raw = response.headers.get(name)
    if (raw !== null && raw.trim() !== '') {
      const milliseconds = Number(raw)
      if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds
    }
  }
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) return undefined
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

/** Equal-jitter exponential backoff, optionally honouring Azure's retry header. */
export function retryDelayMs(
  retryNumber: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
  retryAfterMs?: number
): number {
  const ceiling = Math.max(0, maxDelayMs)
  const randomValue = random()
  const jitter = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5
  if (retryAfterMs !== undefined) {
    const serverDelay = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : ceiling
    const extraJitter = Math.min(250, Math.max(0, ceiling - serverDelay)) * jitter
    return Math.round(Math.min(ceiling, serverDelay + extraJitter))
  }
  const exponential = Math.min(
    ceiling,
    Math.max(0, baseDelayMs) * 2 ** Math.max(0, retryNumber - 1)
  )
  return Math.round(exponential * (0.5 + jitter * 0.5))
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
  if (status === 400 && /image|vision|image_url|multimodal/i.test(detail)) {
    return 'This Azure deployment rejected the screen image. Use a vision-capable deployment, or turn Screen off and try again.'
  }
  if (status === 400 && /content.?filter|responsible.?ai.?policy/i.test(detail)) {
    return 'Azure blocked this request with its content filter. Rephrase the request or remove sensitive source content and try again.'
  }
  if (status === 408) {
    return 'Azure timed out while starting the AI response (408). Try again.'
  }
  if (status >= 500 && status <= 599) {
    return `Azure is temporarily unavailable (${status}). ${detail}`.trim()
  }
  return `AI request failed (${status}) ${detail}`.trim()
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function errorFrom(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback)
}

/**
 * Stream a chat completion from Azure OpenAI.
 * Uses Electron's net.fetch (Chromium network stack) so it honours the system
 * proxy and certificate store — important behind corporate TLS inspection.
 *
 * Resilience for continuous use:
 *  - Retries bounded transient HTTP/network failures with jitter and honours
 *    Azure Retry-After headers.
 *  - Falls back gracefully for newer models that require `max_completion_tokens`
 *    or reject a custom `temperature` (o-series / gpt-5 family).
 *  - Treats a missing [DONE], output truncation, or content-filter termination
 *    as an error instead of presenting a partial response as complete.
 */
export async function streamChat(
  config: AzureConfig,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
  options: StreamChatOptions = {}
): Promise<AzureStreamCompletion | undefined> {
  const base = config.endpoint.replace(/\/+$/, '')
  const deployment = encodeURIComponent(config.deployment)
  const apiVersion = encodeURIComponent(config.apiVersion)
  const url = `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    // Low temperature keeps answers grounded and reduces hallucination/
    // fabrication. A 400-fallback below drops this for models that reject it.
    temperature: 0.2,
    max_completion_tokens: boundedInteger(options.maxOutputTokens, 700, 1, 65_536)
  }
  if (options.includeUsage !== false) body.stream_options = { include_usage: true }

  const maxRetries = boundedInteger(options.maxRetries, 3, 0, 5)
  const baseDelayMs = boundedInteger(options.retryBaseDelayMs, 750, 0, 10_000)
  const maxDelayMs = boundedInteger(options.retryMaxDelayMs, 15_000, 0, 30_000)
  const random = options.random ?? Math.random
  let transientRetries = 0
  let droppedTemperature = false
  let swappedTokenParam = false
  let droppedUsageOption = false

  try {
    for (;;) {
      let response: Response
      try {
        response = await net.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': config.apiKey
          },
          body: JSON.stringify(body),
          signal
        })
      } catch (error) {
        if (isAbort(error, signal)) return undefined
        if (transientRetries >= maxRetries) {
          const cause = errorFrom(error, 'Unknown network failure')
          throw new Error(
            `Could not reach Azure after ${transientRetries + 1} attempts: ${cause.message}`,
            { cause: error }
          )
        }
        transientRetries += 1
        await delay(retryDelayMs(transientRetries, baseDelayMs, maxDelayMs, random), signal)
        continue
      }

      if (response.ok && response.body) {
        let emittedToken = false
        try {
          const completion = await consumeAzureChatStream(response.body, (text) => {
            emittedToken = true
            handlers.onToken(text)
          })
          handlers.onDone(completion)
          return completion
        } catch (error) {
          if (isAbort(error, signal)) return undefined
          const retryable =
            !emittedToken &&
            (!(error instanceof AzureStreamError) || error.retryable) &&
            transientRetries < maxRetries
          if (!retryable) throw error
          transientRetries += 1
          await delay(retryDelayMs(transientRetries, baseDelayMs, maxDelayMs, random), signal)
          continue
        }
      }

      if (response.ok && !response.body) {
        if (transientRetries < maxRetries) {
          transientRetries += 1
          await delay(retryDelayMs(transientRetries, baseDelayMs, maxDelayMs, random), signal)
          continue
        }
        throw new AzureStreamError(
          'incomplete_stream',
          'Azure returned an empty response body before generation could complete.',
          true
        )
      }

      const status = response.status
      const detail = (await response.text().catch(() => '')).slice(0, 400)

      if (
        (status === 408 || status === 429 || (status >= 500 && status <= 599)) &&
        transientRetries < maxRetries
      ) {
        transientRetries += 1
        const waitMs = retryDelayMs(
          transientRetries,
          baseDelayMs,
          maxDelayMs,
          random,
          serverRetryAfterMs(response)
        )
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
      if (
        status === 400 &&
        !droppedUsageOption &&
        'stream_options' in body &&
        /stream_options|include_usage|unrecognized (request )?(argument|field)/i.test(detail)
      ) {
        droppedUsageOption = true
        delete body.stream_options
        continue
      }

      throw new Error(describeError(status, detail))
    }
  } catch (error) {
    if (isAbort(error, signal)) return undefined
    handlers.onError(errorFrom(error, 'Unknown AI streaming error'))
    return undefined
  }
}
