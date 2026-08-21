import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockSocket = {
  readyState: number
  bufferedAmount: number
  sent: unknown[]
  emit(event: string, ...args: unknown[]): void
  close(): void
}

const socketHarness = vi.hoisted(() => ({ instances: [] as MockSocket[] }))

vi.mock('ws', () => {
  class MockWebSocket {
    static readonly OPEN = 1
    readyState = 0
    bufferedAmount = 0
    sent: unknown[] = []
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>()

    constructor() {
      socketHarness.instances.push(this)
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.handlers.get(event) ?? []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    send(value: unknown): void {
      this.sent.push(value)
    }

    close(): void {
      this.readyState = 3
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args)
    }
  }

  return { default: MockWebSocket }
})

import { DeepgramStream } from '../src/main/deepgram'
import { SarvamStream } from '../src/main/sarvam'

function openLatestSocket(): MockSocket {
  const socket = socketHarness.instances.at(-1)
  if (!socket) throw new Error('Expected a WebSocket connection')
  socket.readyState = 1
  socket.emit('open')
  return socket
}

describe('ASR graceful finalization during reconnect backoff', () => {
  beforeEach(() => {
    socketHarness.instances.length = 0
  })

  it('connects Deepgram immediately, uploads queued PCM, and finalizes once', () => {
    const stream = new DeepgramStream({ apiKey: 'test-only', onTranscript: vi.fn() })
    const audio = Buffer.from([1, 2, 3, 4])
    stream.send(audio)

    stream.flush()

    expect(socketHarness.instances).toHaveLength(1)
    const socket = openLatestSocket()
    expect(socket.sent[0]).toEqual(audio)
    expect(socket.sent.slice(1).map((value) => JSON.parse(String(value)))).toEqual([
      { type: 'Finalize' }
    ])

    stream.flush()
    expect(socket.sent).toHaveLength(2)
  })

  it('connects Sarvam immediately, uploads queued PCM, and flushes once', () => {
    const stream = new SarvamStream({ apiKey: 'test-only', onTranscript: vi.fn() })
    const audio = Buffer.from([5, 6, 7, 8])
    stream.send(audio)

    stream.flush()

    expect(socketHarness.instances).toHaveLength(1)
    const socket = openLatestSocket()
    const messages = socket.sent.map((value) => JSON.parse(String(value)))
    expect(Buffer.from(messages[0].audio.data, 'base64')).toEqual(audio)
    expect(messages[1]).toEqual({ type: 'flush' })

    stream.flush()
    expect(socket.sent).toHaveLength(2)
  })

  it('keeps connect idempotent when the delayed retry timer fires later', () => {
    const stream = new SarvamStream({ apiKey: 'test-only', onTranscript: vi.fn() })
    stream.send(Buffer.from([9, 10]))

    stream.flush()
    stream.connect()

    expect(socketHarness.instances).toHaveLength(1)
  })

  it('keeps queued audio bounded when the immediate connection cannot be created', () => {
    const onError = vi.fn()
    const stream = new DeepgramStream({ apiKey: 'test-only', onTranscript: vi.fn(), onError })
    const audio = Buffer.from([11, 12])
    stream.send(audio)
    vi.spyOn(stream, 'connect').mockImplementation(() => {
      throw new Error('socket creation failed')
    })

    expect(() => stream.flush()).not.toThrow()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'socket creation failed' }))
    expect(Buffer.concat(stream.takePendingAudio())).toEqual(audio)
  })
})
