import WebSocket from 'ws'

export type TranscriptHandler = (
  text: string,
  isFinal: boolean,
  speaker?: number,
  confidence?: number
) => void

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

type SpeakerSegment = { speaker: number | undefined; text: string }

/**
 * When two people talk in one burst, Deepgram often returns their words merged
 * into a SINGLE result. Collapsing that to one "dominant" speaker mislabels and
 * runs their sentences together. Instead, split the word list into consecutive
 * same-speaker segments so each speaker's words are attributed correctly — a big
 * accuracy win for fast Speaker 1 ↔ Speaker 2 exchanges.
 */
function splitBySpeaker(words: unknown): SpeakerSegment[] {
  if (!Array.isArray(words) || words.length === 0) return []
  const segs: { speaker: number | undefined; tokens: string[] }[] = []
  let cur: { speaker: number | undefined; tokens: string[] } | null = null
  for (const w of words) {
    const word = w as { speaker?: unknown; word?: unknown; punctuated_word?: unknown }
    const sp = typeof word.speaker === 'number' ? word.speaker : undefined
    const token = (
      typeof word.punctuated_word === 'string'
        ? word.punctuated_word
        : typeof word.word === 'string'
          ? word.word
          : ''
    ).trim()
    if (!token) continue
    if (cur && cur.speaker === sp) {
      cur.tokens.push(token)
    } else {
      cur = { speaker: sp, tokens: [token] }
      segs.push(cur)
    }
  }
  return segs.map((s) => ({ speaker: s.speaker, text: s.tokens.join(' ') }))
}

export interface DeepgramOptions {
  apiKey: string
  sampleRate?: number
  language?: string
  /**
   * Domain terms (product names, tech stack, jargon) to bias recognition toward.
   * Uses nova-3 Keyterm Prompting — English only — so words like "JWT", "OAuth",
   * or "Kubernetes" are transcribed correctly instead of being misheard.
   */
  keyterms?: string[]
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
    const language = opts.language ?? 'en'
    const params = new URLSearchParams({
      // nova-3 is Deepgram's most accurate model — noticeably better than
      // nova-2 for real conversational speech and accented English.
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: String(opts.sampleRate ?? 16000),
      channels: '1',
      // 'en' = nova-3 English (multidialect) — the most accurate choice for
      // English-only meetings, and it handles Indian + American/native accents
      // in one model. Switch to 'multi' only if speech is genuinely code-mixed.
      language,
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
      // Format spoken numbers as digits ("twenty twenty five" -> "2025") so
      // versions, ports, quantities and dates in the transcript are accurate.
      numerals: 'true',
      // Finalise ~250 ms after the speaker pauses. Lower = the transcript text
      // appears much sooner after they stop talking (was 400 ms, which felt
      // laggy); still long enough that normal in-sentence pauses don't chop a
      // sentence into fragments.
      endpointing: '250',
      // Emit an UtteranceEnd event from word timings even when audio never goes
      // fully silent (e.g. background noise on a call), so finals aren't held
      // back waiting for a silence gap that never comes — a common cause of
      // "it delays before showing the text". Requires interim_results (set above).
      utterance_end_ms: '1000'
    })
    // Keyterm Prompting is a nova-3 English-only feature. Feed the meeting's
    // tech stack / product terms so domain jargon is recognised accurately.
    if (language === 'en' && opts.keyterms?.length) {
      for (const term of opts.keyterms.slice(0, 100)) {
        const t = term.trim()
        if (t) params.append('keyterm', t)
      }
    }
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
          const conf = typeof alt?.confidence === 'number' ? alt.confidence : undefined
          const isFinal = Boolean(msg.is_final)
          // On a finalised result, split any merged multi-speaker utterance into
          // one line per speaker so each participant's words are attributed
          // correctly. Only do this when diarization is reliable (a small number
          // of segments); if it flip-flops, fall back to the dominant speaker to
          // avoid choppy fragments.
          if (isFinal) {
            const segments = splitBySpeaker(alt?.words)
            const speakers = new Set(segments.map((s) => s.speaker))
            if (speakers.size > 1 && segments.length <= speakers.size * 3) {
              for (const seg of segments) {
                if (seg.text.trim().length > 0) {
                  this.opts.onTranscript(seg.text, true, seg.speaker, conf)
                }
              }
              return
            }
          }
          this.opts.onTranscript(text, isFinal, dominantSpeaker(alt?.words), conf)
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

  /** Ask Deepgram to finalize the audio received so far without closing yet. */
  flush(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'Finalize' }))
    } catch {
      // The socket's error/close callback owns reporting.
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
