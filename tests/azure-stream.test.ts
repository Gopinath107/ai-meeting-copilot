import { describe, expect, it, vi } from 'vitest'
import {
  AzureStreamError,
  consumeAzureChatStream
} from '../src/main/azureStream'

function streamFrom(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) => controller.enqueue(encoder.encode(part)))
      controller.close()
    }
  })
}

describe('consumeAzureChatStream', () => {
  it('parses chunk-split SSE, usage, finish reason and filter metadata', async () => {
    const onToken = vi.fn()
    const payload = [
      ': keepalive\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop",',
      '"content_filter_results":{"violence":{"filtered":false}}}],',
      '"prompt_filter_results":[{"prompt_index":0}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\r\n\r\n',
      'data: [DONE]\r\n\r\n'
    ]

    const result = await consumeAzureChatStream(streamFrom(payload), onToken)

    expect(onToken.mock.calls.flat()).toEqual(['Hel', 'lo'])
    expect(result).toEqual({
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 2, totalTokens: 14 },
      promptFilterResults: [{ prompt_index: 0 }],
      contentFilterResults: { violence: { filtered: false } }
    })
  })

  it('rejects a clean EOF without the terminal marker', async () => {
    const stream = streamFrom([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n'
    ])

    await expect(consumeAzureChatStream(stream, () => undefined)).rejects.toMatchObject({
      code: 'incomplete_stream',
      retryable: true
    })
  })

  it.each(['length', 'max_tokens'])('reports %s as truncation, never success', async (reason) => {
    const stream = streamFrom([
      `data: {"choices":[{"delta":{},"finish_reason":"${reason}"}]}\n\n`,
      'data: [DONE]\n\n'
    ])

    await expect(consumeAzureChatStream(stream, () => undefined)).rejects.toMatchObject({
      code: 'truncated'
    })
  })

  it('surfaces a content-filter finish reason', async () => {
    const stream = streamFrom([
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter","content_filter_results":{"hate":{"filtered":true}}}]}\n\n',
      'data: [DONE]\n\n'
    ])

    await expect(consumeAzureChatStream(stream, () => undefined)).rejects.toMatchObject(
      {
        code: 'content_filtered',
        details: {
          finishReason: 'content_filter',
          contentFilterResults: { hate: { filtered: true } }
        }
      }
    )
  })

  it('captures a retryable provider error event', async () => {
    const stream = streamFrom([
      'event: error\n',
      'data: {"error":{"code":"rate_limit_exceeded","message":"slow down","status":429}}\n\n'
    ])

    try {
      await consumeAzureChatStream(stream, () => undefined)
      throw new Error('Expected consumeAzureChatStream to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AzureStreamError)
      expect(error).toMatchObject({ code: 'provider_error', retryable: true })
      expect((error as Error).message).toBe('slow down')
    }
  })

  it('rejects malformed data instead of silently marking it done', async () => {
    const stream = streamFrom(['data: {not-json}\n\n', 'data: [DONE]\n\n'])

    await expect(consumeAzureChatStream(stream, () => undefined)).rejects.toMatchObject({
      code: 'malformed_event'
    })
  })
})
