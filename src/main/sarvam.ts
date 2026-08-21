import WebSocket from 'ws'
import { BoundedPcmBuffer } from './asrSession'

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
  takePendingAudio(): Buffer[]
  takeDroppedAudioBytes(): number
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
  private connectStarted = false
  private closed = false
  private flushRequested = false
  private flushSent = false
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingAudio = new BoundedPcmBuffer()
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
    // Graceful Stop may bypass a delayed reconnect to finalize queued audio.
    // Prevent the original retry timer from creating a second socket afterward.
    if (this.closed || this.connectStarted) return
    this.connectStarted = true
    const ws = new WebSocket(this.url, {
      headers: { 'api-subscription-key': this.opts.apiKey }
    })
    this.ws = ws

    ws.on('open', () => {
      if (this.closed || this.ws !== ws) {
        ws.close()
        return
      }
      this.drainPendingAudio(this.flushRequested)
      this.opts.onOpen?.()
    })

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
    ws.on('close', () => {
      if (this.drainTimer) clearTimeout(this.drainTimer)
      this.drainTimer = null
      this.opts.onClose?.()
    })
  }

  send(pcm: ArrayBuffer | Buffer | Uint8Array): void {
    const ws = this.ws
    const buf = Buffer.isBuffer(pcm)
      ? pcm
      : ArrayBuffer.isView(pcm)
        ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
        : Buffer.from(pcm)
    if (
      ws &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount < 256 * 1024 &&
      this.pendingAudio.byteLength === 0
    ) {
      try {
        this.sendBuffer(ws, buf)
        return
      } catch {
        // Preserve this chunk for reconnect/fallback.
      }
    }
    this.pendingAudio.push(buf)
    this.scheduleDrain()
  }

  private sendBuffer(ws: WebSocket, buf: Buffer): void {
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

  private scheduleDrain(): void {
    if (this.drainTimer || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      this.drainPendingAudio()
    }, 40)
  }

  private drainPendingAudio(force = false): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    while (this.pendingAudio.byteLength > 0 && (force || ws.bufferedAmount < 256 * 1024)) {
      const chunk = this.pendingAudio.shift()
      if (!chunk) break
      try {
        this.sendBuffer(ws, chunk)
      } catch {
        this.pendingAudio.prepend(chunk)
        break
      }
    }
    if (this.pendingAudio.byteLength > 0) this.scheduleDrain()
    else this.sendFlushIfReady(ws)
  }

  private sendFlushIfReady(ws: WebSocket): void {
    if (
      !this.flushRequested ||
      this.flushSent ||
      this.pendingAudio.byteLength > 0 ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return
    }
    try {
      ws.send(JSON.stringify({ type: 'flush' }))
      this.flushSent = true
    } catch {
      // Retry briefly while the graceful-stop deadline is still running.
      this.scheduleDrain()
    }
  }

  takePendingAudio(): Buffer[] {
    return this.pendingAudio.drain()
  }

  takeDroppedAudioBytes(): number {
    return this.pendingAudio.takeDroppedBytes()
  }

  flush(): void {
    this.flushRequested = true
    const ws = this.ws
    if (!ws) {
      // A reconnecting stream may still hold the last few seconds of bounded
      // PCM. Connect immediately rather than letting the retry delay outlive
      // the graceful-stop window and discard that tail.
      try {
        this.connect()
      } catch (error) {
        this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    this.drainPendingAudio(true)
  }

  close(): void {
    this.closed = true
    const ws = this.ws
    // Preserve the best-effort behavior of a normal, immediate stop. A graceful
    // stop calls flush(), waits for final transcripts, and only then calls close().
    if (!this.flushSent && ws && ws.readyState === WebSocket.OPEN) this.flush()
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
    this.ws = null
    ws?.close()
  }
}
