import WebSocket from 'ws'

export type TranscriptHandler = (
  text: string,
  isFinal: boolean,
  speaker?: number,
  confidence?: number
) => void

/** Minimal shared shape so the app can use any ASR provider interchangeably. */
export interface AsrStream {
  connect(): void
  send(pcm: ArrayBuffer | Buffer | Uint8Array): void
  flush(): void
  close(): void
}

export interface SarvamOptions {
  apiKey: string
  sampleRate?: number
  /**
   * BCP-47 code. Default 'en-IN' (Indian English) — keeps transcription
   * English-only and tuned for the dominant Indian accent while still handling
   * American/native English. Avoid 'unknown' here: auto-detect could switch to
   * Hindi/code-mixed, which we don't want for an English-only interview.
   */
  language?: string
  /** 'saaras:v3' (default, recommended) or 'saarika:v2.5' (legacy). */
  model?: string
  onTranscript: TranscriptHandler
  onOpen?: () => void
  onError?: (error: Error) => void
  onClose?: () => void
}

/**
 * A single Sarvam AI live-transcription WebSocket stream.
 * Feed it 16 kHz mono 16-bit PCM via send(); finalized utterances arrive on onTranscript.
 *
 * Differences vs the Deepgram path:
 *  - Audio is sent as base64 JSON messages, not raw binary frames.
 *  - Sarvam streaming is VAD-based and emits only finalized segments — there are
 *    no interim/partial results, so every transcript is reported with isFinal=true.
 *  - Streaming has no diarization, so speaker is always undefined (we already
 *    separate interviewer vs you by audio source).
 */
export class SarvamStream implements AsrStream {
  private ws: WebSocket | null = null
  private flushSent = false
  private readonly url: string
  private readonly sampleRate: number

  constructor(private readonly opts: SarvamOptions) {
    this.sampleRate = opts.sampleRate ?? 16000
    const params = new URLSearchParams({
      'language-code': opts.language ?? 'en-IN',
      model: opts.model ?? 'saaras:v3',
      mode: 'transcribe',
      sample_rate: String(this.sampleRate),
      // Required by Sarvam before `{ type: 'flush' }` can immediately process
      // the buffered tail during graceful Stop / End & Minutes.
      flush_signal: 'true',
      // We stream raw little-endian 16-bit PCM (same bytes as the Deepgram path).
      input_audio_codec: 'pcm_s16le'
    })
    this.url = `wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`
  }

  connect(): void {
    const ws = new WebSocket(this.url, {
      headers: { 'api-subscription-key': this.opts.apiKey }
    })
    this.ws = ws

    ws.on('open', () => this.opts.onOpen?.())

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg?.type === 'data') {
          const text: unknown = msg?.data?.transcript
          if (typeof text === 'string' && text.trim().length > 0) {
            // Sarvam streaming returns finalized utterances only.
            this.opts.onTranscript(text, true)
          }
        } else if (msg?.type === 'error') {
          const message: unknown = msg?.data?.error
          this.opts.onError?.(
            new Error(typeof message === 'string' ? message : 'Sarvam stream error')
          )
        }
        // type === 'events' (VAD signals) is ignored.
      } catch {
        // Ignore non-JSON / keepalive frames.
      }
    })

    ws.on('error', (error) => this.opts.onError?.(error))
    ws.on('close', () => this.opts.onClose?.())
  }

  send(pcm: ArrayBuffer | Buffer | Uint8Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const buf = Buffer.isBuffer(pcm)
      ? pcm
      : ArrayBuffer.isView(pcm)
        ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        : Buffer.from(pcm)
    ws.send(
      JSON.stringify({
        audio: {
          data: buf.toString('base64'),
          sample_rate: String(this.sampleRate),
          encoding: 'audio/wav'
        }
      })
    )
  }

  flush(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'flush' }))
      this.flushSent = true
    } catch {
      // The socket's error/close callback owns reporting.
    }
  }

  close(): void {
    const ws = this.ws
    // Preserve the best-effort behavior of a normal, immediate stop. A graceful
    // stop calls flush(), waits for final transcripts, and only then calls close().
    if (!this.flushSent && ws && ws.readyState === WebSocket.OPEN) this.flush()
    this.ws = null
    ws?.close()
  }
}
