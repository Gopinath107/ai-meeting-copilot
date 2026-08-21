export type AzureStreamUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export type AzureStreamCompletion = {
  finishReason: string | null
  usage?: AzureStreamUsage
  promptFilterResults?: unknown
  contentFilterResults?: unknown
}

export type AzureStreamErrorCode =
  | 'content_filtered'
  | 'incomplete_stream'
  | 'malformed_event'
  | 'provider_error'
  | 'truncated'
  | 'unsupported_finish_reason'

export class AzureStreamError extends Error {
  readonly code: AzureStreamErrorCode
  readonly retryable: boolean
  readonly details?: unknown

  constructor(code: AzureStreamErrorCode, message: string, retryable = false, details?: unknown) {
    super(message)
    this.name = 'AzureStreamError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseUsage(value: unknown): AzureStreamUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage: AzureStreamUsage = {
    promptTokens: finiteNumber(value.prompt_tokens),
    completionTokens: finiteNumber(value.completion_tokens),
    totalTokens: finiteNumber(value.total_tokens)
  }
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined
}

function providerError(payload: JsonRecord, forced = false): AzureStreamError | null {
  const error = isRecord(payload.error) ? payload.error : forced ? payload : null
  if (!error) return null
  const message =
    typeof error.message === 'string'
      ? error.message.slice(0, 400)
      : 'Azure returned a stream error.'
  const numericCode =
    typeof error.code === 'string' && error.code.trim() !== '' ? Number(error.code) : undefined
  const status =
    finiteNumber(error.status) ??
    finiteNumber(error.code) ??
    (Number.isFinite(numericCode) ? numericCode : undefined)
  const code = typeof error.code === 'string' ? error.code : ''
  const retryable =
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    /rate[_ -]?limit|timeout|temporar|server_error|service_unavailable/i.test(code)
  return new AzureStreamError('provider_error', message, retryable, error)
}

function tokenText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (!isRecord(part)) return ''
      return typeof part.text === 'string' ? part.text : ''
    })
    .join('')
}

function terminalError(completion: AzureStreamCompletion): AzureStreamError | null {
  if (completion.finishReason === 'length' || completion.finishReason === 'max_tokens') {
    return new AzureStreamError(
      'truncated',
      'The AI response reached its output-token limit and was cut off. Retry with a larger output budget or a shorter input.',
      false,
      completion
    )
  }
  if (completion.finishReason === 'content_filter') {
    return new AzureStreamError(
      'content_filtered',
      'Azure stopped the response because its content filter was triggered.',
      false,
      completion
    )
  }
  if (completion.finishReason && completion.finishReason !== 'stop') {
    return new AzureStreamError(
      'unsupported_finish_reason',
      `Azure ended the response with unsupported finish reason "${completion.finishReason}".`,
      false,
      completion
    )
  }
  return null
}

/**
 * Consume Azure's Server-Sent Events response without assuming network chunks
 * align to lines or events. A successful response must include Azure's [DONE]
 * marker; a clean socket close by itself is not proof that generation finished.
 */
export async function consumeAzureChatStream(
  body: ReadableStream<Uint8Array>,
  onToken: (text: string) => void
): Promise<AzureStreamCompletion> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let dataLines: string[] = []
  let eventName = ''
  let sawDone = false
  let finishReason: string | null = null
  let usage: AzureStreamUsage | undefined
  let promptFilterResults: unknown
  let contentFilterResults: unknown

  const dispatchEvent = (): void => {
    const data = dataLines.join('\n')
    dataLines = []
    const currentEventName = eventName
    eventName = ''
    if (!data) return
    if (data.trim() === '[DONE]') {
      sawDone = true
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new AzureStreamError(
        'malformed_event',
        'Azure returned a malformed streaming event. The response was not accepted as complete.'
      )
    }
    if (!isRecord(parsed)) {
      throw new AzureStreamError('malformed_event', 'Azure returned an invalid streaming event.')
    }

    const streamError = providerError(parsed, currentEventName === 'error')
    if (streamError) {
      throw streamError
    }

    usage = parseUsage(parsed.usage) ?? usage
    if (parsed.prompt_filter_results !== undefined) {
      promptFilterResults = parsed.prompt_filter_results
    }

    if (!Array.isArray(parsed.choices)) return
    for (const rawChoice of parsed.choices) {
      if (!isRecord(rawChoice)) continue
      if (typeof rawChoice.finish_reason === 'string') finishReason = rawChoice.finish_reason
      if (rawChoice.content_filter_results !== undefined) {
        contentFilterResults = rawChoice.content_filter_results
      }
      if (!isRecord(rawChoice.delta)) continue
      const text = tokenText(rawChoice.delta.content)
      if (text) onToken(text)
    }
  }

  const processLine = (line: string): void => {
    if (line === '') {
      dispatchEvent()
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') dataLines.push(value)
    else if (field === 'event') eventName = value
  }

  const processDecoded = (decoded: string): void => {
    lineBuffer += decoded
    for (;;) {
      const newline = lineBuffer.indexOf('\n')
      if (newline < 0) break
      let line = lineBuffer.slice(0, newline)
      lineBuffer = lineBuffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      processLine(line)
      if (sawDone) return
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      processDecoded(decoder.decode(value, { stream: true }))
      if (sawDone) break
    }
    if (!sawDone) {
      processDecoded(decoder.decode())
      if (lineBuffer) {
        let finalLine = lineBuffer
        if (finalLine.endsWith('\r')) finalLine = finalLine.slice(0, -1)
        processLine(finalLine)
        lineBuffer = ''
      }
      if (dataLines.length > 0) dispatchEvent()
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }
  if (sawDone) await reader.cancel().catch(() => undefined)

  const completion: AzureStreamCompletion = {
    finishReason,
    usage,
    promptFilterResults,
    contentFilterResults
  }
  const finishError = terminalError(completion)
  if (finishError) throw finishError
  if (!sawDone) {
    throw new AzureStreamError(
      'incomplete_stream',
      'The AI response stream ended before Azure sent its completion marker. The partial response may be incomplete.',
      true
    )
  }

  return completion
}
