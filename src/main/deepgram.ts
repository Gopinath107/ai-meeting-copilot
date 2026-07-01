import WebSocket from 'ws'

export type TranscriptHandler = (text: string, isFinal: boolean, speaker?: number) => void

/** Pick the speaker (Deepgram diarization index) that owns most words in an utterance. */
function dominantSpeaker(words: unknown): number | undefined {
  if (!Array.isArray(words) || words.length === 0) return undefined
  const counts = new Map<number, number>()
  for (const w of words) {
    const s = (w as { speaker?: unknown }).speaker
    if (typeof s === 'number') counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  let best: number | undefined
  let bestCount = -1
  for (const [s, c] of counts) {
    if (c > bestCount) {
      bestCount = c
      best = s
    }
  }
  return best
}

export interface DeepgramOptions {
  apiKey: string
  sampleRate?: number
  language?: string
  onTranscript: TranscriptHandler
  onOpen?: () => void
  onError?: (error: Error) => void
  onClose?: () => void
  /**
   * Behind a corporate TLS-inspection proxy the bundled CA store may reject the
   * Deepgram handshake. Set DEEPGRAM_ALLOW_INSECURE_TLS=true to opt out of cert
   * verification (default stays secure).
   */
  allowInsecureTls?: boolean
}

/**
 * A single Deepgram live-transcription WebSocket stream.
 * Feed it 16 kHz mono linear16 PCM via send(); transcripts arrive on onTranscript.
 */
export class DeepgramStream {
  private ws: WebSocket | null = null
  private keepAlive: ReturnType<typeof setInterval> | null = null
  private readonly url: string

  constructor(private readonly opts: DeepgramOptions) {
    const params = new URLSearchParams({
      model: 'nova-2',
      encoding: 'linear16',
      sample_rate: String(opts.sampleRate ?? 16000),
      channels: '1',
      // 'en' is Deepgram's multidialect English model — English-only, and it
      // handles mixed Indian + American/native accents in one model (the
      // interview is ~80% Indian-accented English, ~20% American English).
      language: opts.language ?? 'en',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
      endpointing: '300'
    })
    this.url = `wss://api.deepgram.com/v1/listen?${params.toString()}`
  }

  connect(): void {
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
      rejectUnauthorized: !this.opts.allowInsecureTls
    })
    this.ws = ws

    ws.on('open', () => {
      this.opts.onOpen?.()
      // Deepgram closes idle sockets after ~10s; KeepAlive guards silent gaps.
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }))
        }
      }, 5000)
    })

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString())
        const alt = msg?.channel?.alternatives?.[0]
        const text: unknown = alt?.transcript
        if (typeof text === 'string' && text.trim().length > 0) {
          this.opts.onTranscript(text, Boolean(msg.is_final), dominantSpeaker(alt?.words))
        }
      } catch {
        // Metadata / non-JSON frames are ignored.
      }
    })

    ws.on('error', (error) => this.opts.onError?.(error))
    ws.on('close', () => {
      if (this.keepAlive) clearInterval(this.keepAlive)
      this.keepAlive = null
      this.opts.onClose?.()
    })
  }

  send(pcm: ArrayBuffer | Buffer | Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcm)
    }
  }

  close(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive)
      this.keepAlive = null
    }
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        // ignore
      }
    }
    ws?.close()
  }
}
