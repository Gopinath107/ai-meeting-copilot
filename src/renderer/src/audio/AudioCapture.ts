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
  async startSystem(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    // We only want the audio; the screen video track is captured but immediately discarded.
    stream.getVideoTracks().forEach((track) => track.stop())
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      throw new Error('No system audio captured (loopback unavailable)')
    }
    await this.attach('system', new MediaStream(audioTracks))
  }

  /** The user's microphone. */
  async startMic(deviceId?: string): Promise<void> {
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
    await this.attach('mic', stream)
  }

  private async attach(kind: AudioSourceKind, stream: MediaStream): Promise<void> {
    const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    try {
      await ctx.audioWorklet.addModule(this.getWorkletUrl())
    } catch (error) {
      await ctx.close()
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-processor')
    node.port.onmessage = (event: MessageEvent): void => {
      const pcm = event.data as Int16Array
      this.handlers.onLevel(kind, computeRms(pcm))
      this.handlers.onChunk(kind, pcm)
    }

    // A muted sink keeps the worklet in the render graph without audible playback.
    const sink = ctx.createGain()
    sink.gain.value = 0
    source.connect(node)
    node.connect(sink)
    sink.connect(ctx.destination)

    stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop(kind))

    this.contexts.set(kind, ctx)
    this.streams.set(kind, stream)
    this.nodes.set(kind, node)
  }

  stop(kind?: AudioSourceKind): void {
    const kinds: AudioSourceKind[] = kind ? [kind] : ['system', 'mic']
    for (const k of kinds) {
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
