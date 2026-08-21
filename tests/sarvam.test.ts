import { describe, expect, it, vi } from 'vitest'
import { SarvamStream } from '../src/main/sarvam'

describe('SarvamStream graceful finalization', () => {
  it('enables the server-side flush signal in the connection URL', () => {
    const stream = new SarvamStream({
      apiKey: 'test-only',
      onTranscript: vi.fn()
    })
    const url = new URL(Reflect.get(stream, 'url') as string)

    expect(url.searchParams.get('flush_signal')).toBe('true')
  })

  it('buffers audio sent before the socket is ready', () => {
    const stream = new SarvamStream({
      apiKey: 'test-only',
      onTranscript: vi.fn()
    })

    stream.send(Buffer.from([1, 2, 3, 4]))

    expect(Buffer.concat(stream.takePendingAudio())).toEqual(Buffer.from([1, 2, 3, 4]))
  })
})
