import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ net: { fetch: fetchMock } }))
vi.mock('../src/main/settings', () => ({ getSettings: vi.fn() }))

import {
  retryDelayMs,
  serverRetryAfterMs,
  streamChat,
  type AzureConfig,
  type StreamHandlers
} from '../src/main/azure'

const config: AzureConfig = {
  endpoint: 'https://example.openai.azure.com/',
  apiKey: 'test-key',
  deployment: 'test deployment',
  apiVersion: '2024-10-21'
}
const messages = [{ role: 'user' as const, content: 'Hello' }]

function successfulResponse(token = 'answer'): Response {
  return new Response(
    [
      `data: {"choices":[{"delta":{"content":"${token}"},"finish_reason":null}]}\n\n`,
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function handlers(): StreamHandlers & {
  onToken: ReturnType<typeof vi.fn>
  onDone: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
}

describe('streamChat', () => {
  beforeEach(() => fetchMock.mockReset())

  it('preserves callers while allowing a per-request output budget', async () => {
    fetchMock.mockResolvedValueOnce(successfulResponse())
    const events = handlers()

    const result = await streamChat(config, messages, events, undefined, {
      maxOutputTokens: 2_400
    })

    const [url, init] = fetchMock.mock.calls[0]
    const requestBody = JSON.parse(String(init.body))
    expect(url).toContain('/deployments/test%20deployment/chat/completions')
    expect(requestBody.max_completion_tokens).toBe(2_400)
    expect(requestBody.stream_options).toEqual({ include_usage: true })
    expect(events.onToken).toHaveBeenCalledWith('answer')
    expect(events.onDone).toHaveBeenCalledOnce()
    expect(events.onError).not.toHaveBeenCalled()
    expect(result?.finishReason).toBe('stop')
  })

  it.each([408, 429, 500, 503])('retries transient HTTP %s responses', async (status) => {
    fetchMock
      .mockResolvedValueOnce(new Response('temporary failure', { status }))
      .mockResolvedValueOnce(successfulResponse())
    const events = handlers()

    await streamChat(config, messages, events, undefined, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.onDone).toHaveBeenCalledOnce()
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('retries a network failure before a response begins', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('socket reset')).mockResolvedValueOnce(successfulResponse())
    const events = handlers()

    await streamChat(config, messages, events, undefined, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.onDone).toHaveBeenCalledOnce()
    expect(events.onError).not.toHaveBeenCalled()
  })

  it('retries an interrupted stream only when no token reached the UI', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n')
      )
      .mockResolvedValueOnce(successfulResponse())
    const events = handlers()

    await streamChat(config, messages, events, undefined, {
      maxRetries: 1,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events.onDone).toHaveBeenCalledOnce()
  })

  it('does not retry after a partial response because that would duplicate visible text', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n')
    )
    const events = handlers()

    await streamChat(config, messages, events, undefined, {
      maxRetries: 3,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(events.onToken).toHaveBeenCalledWith('partial')
    expect(events.onDone).not.toHaveBeenCalled()
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'incomplete_stream' })
    )
  })

  it('falls back when an API version does not support streamed usage', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('Unrecognized request argument supplied: stream_options', { status: 400 })
      )
      .mockResolvedValueOnce(successfulResponse())
    const events = handlers()

    await streamChat(config, messages, events, undefined, {
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    })

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body))
    expect(firstBody.stream_options).toEqual({ include_usage: true })
    expect(secondBody.stream_options).toBeUndefined()
    expect(events.onDone).toHaveBeenCalledOnce()
  })

  it('reports a final transient error after the retry budget is exhausted', async () => {
    fetchMock.mockResolvedValue(new Response('still unavailable', { status: 503 }))
    const events = handlers()

    await streamChat(config, messages, events, undefined, {
      maxRetries: 2,
      retryBaseDelayMs: 0,
      retryMaxDelayMs: 0
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(events.onDone).not.toHaveBeenCalled()
    expect(events.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('temporarily unavailable') })
    )
  })
})

describe('retryDelayMs', () => {
  it('uses bounded equal jitter for exponential backoff', () => {
    expect(retryDelayMs(1, 1_000, 10_000, () => 0)).toBe(500)
    expect(retryDelayMs(3, 1_000, 10_000, () => 1)).toBe(4_000)
    expect(retryDelayMs(8, 1_000, 10_000, () => 1)).toBe(10_000)
  })

  it('honours a server delay while retaining bounded jitter', () => {
    expect(retryDelayMs(1, 1_000, 10_000, () => 0, 7_000)).toBe(7_000)
    expect(retryDelayMs(1, 1_000, 7_100, () => 1, 7_000)).toBe(7_100)
  })

  it('parses Azure millisecond, standard seconds, and HTTP-date retry headers', () => {
    expect(
      serverRetryAfterMs(new Response(null, { headers: { 'retry-after-ms': '1750' } }), 0)
    ).toBe(1_750)
    expect(serverRetryAfterMs(new Response(null, { headers: { 'retry-after': '2' } }), 0)).toBe(
      2_000
    )
    expect(
      serverRetryAfterMs(
        new Response(null, { headers: { 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' } }),
        1_000
      )
    ).toBe(4_000)
  })
})
