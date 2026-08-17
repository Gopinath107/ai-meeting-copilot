import { pcmWorkletSource } from './pcmWorklet'

export type AudioSourceKind = 'system' | 'mic'

export type AudioCaptureHandlers = {
  onLevel: (kind: AudioSourceKind, level: number) => void
  onChunk: (kind: AudioSourceKind, pcm: Int16Array) => void
  onError: (kind: AudioSourceKind, error: Error) => void
}

// Capture at 16 kHz mono. This is the rate Sarvam's streaming STT (our primary
// provider) requires; Deepgram accepts it too. Sending 48 kHz broke Sarvam
// (stream stops / garbled text), so keep both capture and the declared
// sample_rate at 16 kHz.
const TARGET_SAMPLE_RATE = 16000

function computeRms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 0x8000
    sum += v * v
  }
  return Math.sqrt(sum / pcm.length)
}

/**
 * Captures the interviewer's voice (system loopback) and the user's microphone,
 * resamples both to 16 kHz mono, and emits Int16 PCM chunks for the ASR pipeline.
 */
export class AudioCapture {
  private readonly handlers: AudioCaptureHandlers
  private readonly contexts = new Map<AudioSourceKind, AudioContext>()
  private readonly streams = new Map<AudioSourceKind, MediaStream>()
  private readonly nodes = new Map<AudioSourceKind, AudioWorkletNode>()
  private readonly generations: Record<AudioSourceKind, number> = { system: 0, mic: 0 }
  private readonly flushWaiters = new Map<
    string,
    { kind: AudioSourceKind; resolve: () => void; reject: (error: Error) => void; timer: number }
  >()
  private flushSequence = 0
  private screenStream: MediaStream | null = null
  private screenVideo: HTMLVideoElement | null = null
  private workletUrl: string | null = null

  constructor(handlers: AudioCaptureHandlers) {
    this.handlers = handlers
  }

  private getWorkletUrl(): string {
    if (!this.workletUrl) {
      const blob = new Blob([pcmWorkletSource], { type: 'application/javascript' })
      this.workletUrl = URL.createObjectURL(blob)
    }
    return this.workletUrl
  }

  /** System audio loopback (the interviewer). Requires the main-process display-media handler. */
  async startSystem(captureScreen = false): Promise<boolean> {
    const generation = ++this.generations.system
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    this.ensureActive('system', generation, stream)
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('No system audio captured (loopback unavailable)')
    }

    let screenReady = false
    const videoTrack = stream.getVideoTracks()[0]
    if (captureScreen && videoTrack) {
      const videoStream = new MediaStream([videoTrack])
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.style.position = 'absolute'
      video.style.opacity = '0'
      video.style.pointerEvents = 'none'
      document.body.appendChild(video)
      video.srcObject = videoStream
      this.screenStream = videoStream
      this.screenVideo = video
      videoTrack.addEventListener(
        'ended',
        () => {
          if (this.screenVideo === video) {
            this.handlers.onError('system', new Error('Screen sharing ended'))
            this.stop('system')
          }
        },
        { once: true }
      )
      try {
        await video.play()
        await this.waitForVideoFrame(video, generation)
        this.ensureActive('system', generation, stream)
        screenReady = true
      } catch (error) {
        this.stopScreenCapture()
        if ((error as Error).name === 'AbortError') {
          audioTracks.forEach((track) => track.stop())
          throw error
        }
        this.handlers.onError(
          'system',
          new Error(
            `Screen context unavailable: ${(error as Error).message}. System audio will continue.`
          )
        )
      }
    } else {
      stream.getVideoTracks().forEach((track) => track.stop())
      if (captureScreen) {
        this.handlers.onError(
          'system',
          new Error('Selected display did not provide a video track. System audio will continue.')
        )
      }
    }

    try {
      await this.attach('system', new MediaStream(audioTracks), generation)
    } catch (error) {
      audioTracks.forEach((track) => track.stop())
      this.stopScreenCapture()
      throw error
    }
    return screenReady
  }

  private ensureActive(
    kind: AudioSourceKind,
    generation: number,
    stream?: MediaStream
  ): void {
    if (generation === this.generations[kind]) return
    stream?.getTracks().forEach((track) => track.stop())
    throw new DOMException('Capture stopped', 'AbortError')
  }

  private async waitForVideoFrame(video: HTMLVideoElement, generation: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let done = false
      let frameCallbackId: number | null = null
      const finish = (error?: Error): void => {
        if (done) return
        done = true
        window.clearTimeout(timeout)
        window.clearInterval(activeCheck)
        if (frameCallbackId !== null && video.cancelVideoFrameCallback) {
          video.cancelVideoFrameCallback(frameCallbackId)
        }
        if (error) reject(error)
        else resolve()
      }
      const verifyFrame = (): void => {
        try {
          this.ensureActive('system', generation)
          if (video.videoWidth > 0 && video.videoHeight > 0) finish()
          else if (video.requestVideoFrameCallback) {
            frameCallbackId = video.requestVideoFrameCallback(verifyFrame)
          }
        } catch (error) {
          finish(error as Error)
        }
      }
      const activeCheck = window.setInterval(() => {
        try {
          this.ensureActive('system', generation)
          if (!video.requestVideoFrameCallback &&
              video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              video.videoWidth > 0 && video.videoHeight > 0) finish()
        } catch (error) {
          finish(error as Error)
        }
      }, 50)
      const timeout = window.setTimeout(
        () =>
          finish(
            new Error(
              'Timed out waiting for a frame from the selected display. Re-select a connected display and ensure screen capture is allowed.'
            )
          ),
        10000
      )
      if (video.requestVideoFrameCallback) {
        frameCallbackId = video.requestVideoFrameCallback(verifyFrame)
      }
    })
  }

  /** Capture the current shared screen as a compact JPEG data URL for vision input. */
  captureScreenFrame(
    maxWidth = 1440,
    maxHeight = 900,
    quality = 0.72
  ): { dataUrl: `data:image/jpeg;base64,${string}`; width: number; height: number; capturedAt: number } | null {
    const video = this.screenVideo
    const track = this.screenStream?.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') return null
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return null

    const scale = Math.min(1, maxWidth / video.videoWidth, maxHeight / video.videoHeight)
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) return null
    return {
      dataUrl: dataUrl as `data:image/jpeg;base64,${string}`,
      width,
      height,
      capturedAt: Date.now()
    }
  }

  private stopScreenCapture(): void {
    const video = this.screenVideo
    this.screenVideo = null
    if (video) {
      if (video.parentNode) video.parentNode.removeChild(video)
      video.pause()
      video.srcObject = null
    }
    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
  }

  /** The user's microphone. */
  async startMic(deviceId?: string): Promise<void> {
    const generation = ++this.generations.mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    })
    this.ensureActive('mic', generation, stream)
    await this.attach('mic', stream, generation)
  }

  private async attach(
    kind: AudioSourceKind,
    stream: MediaStream,
    generation: number
  ): Promise<void> {
    let ctx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let node: AudioWorkletNode | null = null
    let sink: GainNode | null = null
    try {
      this.ensureActive(kind, generation, stream)
      ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      await ctx.audioWorklet.addModule(this.getWorkletUrl())
      this.ensureActive(kind, generation, stream)
      if (ctx.state === 'suspended') await ctx.resume()
      this.ensureActive(kind, generation, stream)

      source = ctx.createMediaStreamSource(stream)
      node = new AudioWorkletNode(ctx, 'pcm-processor')
      node.port.onmessage = (event: MessageEvent): void => {
        const data: unknown = event.data
        if (
          data &&
          typeof data === 'object' &&
          (data as { type?: unknown }).type === 'flushed' &&
          typeof (data as { requestId?: unknown }).requestId === 'string'
        ) {
          const requestId = (data as { requestId: string }).requestId
          const waiter = this.flushWaiters.get(requestId)
          if (waiter) {
            window.clearTimeout(waiter.timer)
            this.flushWaiters.delete(requestId)
            waiter.resolve()
          }
          return
        }
        if (!(data instanceof Int16Array) || this.nodes.get(kind) !== node) return
        const pcm = data
        this.handlers.onLevel(kind, computeRms(pcm))
        this.handlers.onChunk(kind, pcm)
      }

      // A muted sink keeps the worklet in the render graph without audible playback.
      sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)
      this.ensureActive(kind, generation, stream)

      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        this.handlers.onError(
          kind,
          new Error(kind === 'system' ? 'System audio ended' : 'Microphone ended')
        )
        this.stop(kind)
      })
      this.contexts.set(kind, ctx)
      this.streams.set(kind, stream)
      this.nodes.set(kind, node)
    } catch (error) {
      node?.disconnect()
      source?.disconnect()
      sink?.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      if (ctx) await ctx.close().catch(() => undefined)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /** Emit each worklet's partial (<100 ms) PCM buffer before stopping capture. */
  async flush(kind?: AudioSourceKind, timeoutMs = 750): Promise<void> {
    const kinds: AudioSourceKind[] = kind ? [kind] : ['system', 'mic']
    await Promise.all(
      kinds.map((sourceKind) => {
        const node = this.nodes.get(sourceKind)
        if (!node) return Promise.resolve()
        const requestId = `${sourceKind}:${++this.flushSequence}`
        return new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            this.flushWaiters.delete(requestId)
            reject(new Error(`Timed out flushing ${sourceKind} audio`))
          }, Math.max(100, timeoutMs))
          this.flushWaiters.set(requestId, { kind: sourceKind, resolve, reject, timer })
          node.port.postMessage({ type: 'flush', requestId })
        })
      })
    )
  }

  async stopGracefully(kind?: AudioSourceKind): Promise<void> {
    await this.flush(kind)
    this.stop(kind)
  }

  stop(kind?: AudioSourceKind): void {
    const kinds: AudioSourceKind[] = kind ? [kind] : ['system', 'mic']
    for (const k of kinds) this.generations[k] += 1
    if (!kind || kind === 'system') this.stopScreenCapture()
    for (const k of kinds) {
      for (const [requestId, waiter] of this.flushWaiters) {
        if (waiter.kind !== k) continue
        window.clearTimeout(waiter.timer)
        this.flushWaiters.delete(requestId)
        waiter.reject(new DOMException('Capture stopped', 'AbortError'))
      }
      this.nodes.get(k)?.disconnect()
      this.streams.get(k)?.getTracks().forEach((track) => track.stop())
      void this.contexts.get(k)?.close()
      this.nodes.delete(k)
      this.streams.delete(k)
      this.contexts.delete(k)
    }
    if (!kind && this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }
  }
}
