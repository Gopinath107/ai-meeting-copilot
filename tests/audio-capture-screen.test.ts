import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioCapture } from '../src/renderer/src/audio/AudioCapture'

class FakeTrack {
  readonly kind: 'audio' | 'video'
  readyState: MediaStreamTrackState = 'live'
  stopped = false
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(kind: 'audio' | 'video') {
    this.kind = kind
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  stop(): void {
    this.stopped = true
    this.readyState = 'ended'
  }

  end(): void {
    this.readyState = 'ended'
    for (const listener of this.listeners.get('ended') ?? []) listener()
  }
}

class FakeStream {
  private readonly tracks: FakeTrack[]

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks]
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio')
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function installBrowserFakes(getDisplayMedia: () => Promise<FakeStream>): {
  createElement: ReturnType<typeof vi.fn>
} {
  const body = {
    appendChild: vi.fn((node: { parentNode: unknown }) => {
      node.parentNode = body
      return node
    }),
    removeChild: vi.fn((node: { parentNode: unknown }) => {
      node.parentNode = null
      return node
    })
  }
  const createElement = vi.fn((tag: string) => {
    if (tag !== 'video') throw new Error(`Unexpected element: ${tag}`)
    return {
      muted: false,
      playsInline: false,
      style: {},
      parentNode: null,
      srcObject: null,
      readyState: 4,
      videoWidth: 1280,
      videoHeight: 720,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      requestVideoFrameCallback: vi.fn((callback: () => void) => {
        queueMicrotask(callback)
        return 1
      }),
      cancelVideoFrameCallback: vi.fn()
    }
  })

  vi.stubGlobal('MediaStream', FakeStream)
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } })
  vi.stubGlobal('document', { body, createElement })
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  })
  return { createElement }
}

function createCapture(systemStream: FakeStream) {
  const onError = vi.fn()
  const onScreenEnded = vi.fn()
  const capture = new AudioCapture({
    onLevel: vi.fn(),
    onChunk: vi.fn(),
    onError,
    onScreenEnded
  })
  const internals = capture as unknown as {
    streams: Map<'system' | 'mic', MediaStream>
  }
  internals.streams.set('system', systemStream as unknown as MediaStream)
  return { capture, onError, onScreenEnded }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('independent screen capture lifecycle', () => {
  it('reports a display-track ending without stopping system audio', async () => {
    const audioTrack = new FakeTrack('audio')
    const videoTrack = new FakeTrack('video')
    const systemStream = new FakeStream([audioTrack])
    installBrowserFakes(async () => new FakeStream([videoTrack]))
    const { capture, onError, onScreenEnded } = createCapture(systemStream)

    await expect(capture.startScreen()).resolves.toBe(true)
    videoTrack.end()

    expect(onScreenEnded).toHaveBeenCalledWith(expect.objectContaining({ message: 'Screen sharing ended' }))
    expect(onError).not.toHaveBeenCalled()
    expect(audioTrack.stopped).toBe(false)
    expect(audioTrack.readyState).toBe('live')
  })

  it('invalidates a pending display picker when screen context is turned off', async () => {
    const pending = deferred<FakeStream>()
    const audioTrack = new FakeTrack('audio')
    const videoTrack = new FakeTrack('video')
    const systemStream = new FakeStream([audioTrack])
    const { createElement } = installBrowserFakes(() => pending.promise)
    const { capture, onError } = createCapture(systemStream)

    const starting = capture.startScreen()
    capture.stopScreen()
    pending.resolve(new FakeStream([videoTrack]))

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(videoTrack.stopped).toBe(true)
    expect(createElement).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(audioTrack.stopped).toBe(false)
  })

  it('invalidates a pending display picker when the system session stops', async () => {
    const pending = deferred<FakeStream>()
    const audioTrack = new FakeTrack('audio')
    const videoTrack = new FakeTrack('video')
    const systemStream = new FakeStream([audioTrack])
    installBrowserFakes(() => pending.promise)
    const { capture, onError } = createCapture(systemStream)

    const starting = capture.startScreen()
    capture.stop('system')
    pending.resolve(new FakeStream([videoTrack]))

    await expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    expect(videoTrack.stopped).toBe(true)
    expect(audioTrack.stopped).toBe(true)
    expect(onError).not.toHaveBeenCalled()
  })
})
