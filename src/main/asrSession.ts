export type AsrKind = 'system' | 'mic'

export interface ClosableAsrStream {
  close(): void
}

type Slot<T extends ClosableAsrStream> = {
  generation: number
  stream: T | null
  intentionalClose: boolean
}

export type AsrSessionSnapshot<T extends ClosableAsrStream> = {
  kind: AsrKind
  generation: number
  stream: T
}

export type FinalTranscriptSettleResult = {
  timedOut: boolean
  sawFinal: boolean
}

/** Five seconds of 16 kHz mono PCM16 audio. */
export const DEFAULT_PENDING_PCM_BYTES = 16_000 * 2 * 5

/**
 * Small, byte-bounded FIFO used while an ASR socket is connecting or its
 * network writer is backed up. Keeping this independent from WebSocket makes
 * the loss policy deterministic and straightforward to test.
 */
export class BoundedPcmBuffer {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = 0

  constructor(private readonly maxBytes = DEFAULT_PENDING_PCM_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive integer')
    }
  }

  push(value: ArrayBuffer | Buffer | Uint8Array): void {
    const source = Buffer.isBuffer(value)
      ? value
      : ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(value)
    if (source.byteLength === 0) return

    // Own a copy: Electron may release or detach an IPC-backed ArrayBuffer
    // after the event callback returns.
    let chunk = Buffer.from(source)
    if (chunk.byteLength > this.maxBytes) {
      this.dropped += chunk.byteLength - this.maxBytes
      chunk = chunk.subarray(chunk.byteLength - this.maxBytes)
    }
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength

    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.bytes - this.maxBytes
      const first = this.chunks[0]
      if (first.byteLength <= overflow) {
        this.chunks.shift()
        this.bytes -= first.byteLength
        this.dropped += first.byteLength
      } else {
        this.chunks[0] = first.subarray(overflow)
        this.bytes -= overflow
        this.dropped += overflow
      }
    }
  }

  shift(): Buffer | undefined {
    const chunk = this.chunks.shift()
    if (chunk) this.bytes -= chunk.byteLength
    return chunk
  }

  /** Return a chunk to the head after a transport send failed. */
  prepend(chunk: Buffer): void {
    if (chunk.byteLength === 0) return
    this.chunks.unshift(chunk)
    this.bytes += chunk.byteLength
  }

  drain(): Buffer[] {
    const chunks = this.chunks
    this.chunks = []
    this.bytes = 0
    return chunks
  }

  get byteLength(): number {
    return this.bytes
  }

  takeDroppedBytes(): number {
    const dropped = this.dropped
    this.dropped = 0
    return dropped
  }
}

/** Capped exponential retry delay with a little deterministic-free jitter. */
export function reconnectDelayMs(attempt: number, random = Math.random): number {
  const normalizedAttempt = Math.max(1, Math.min(20, Math.floor(attempt)))
  const base = Math.min(15_000, 500 * 2 ** (normalizedAttempt - 1))
  return Math.round(base * (0.8 + random() * 0.4))
}

/**
 * Advance reconnect backoff unless the previous socket proved healthy.
 * Merely reaching OPEN is not enough: short open/close loops should continue
 * backing off instead of retrying every 500 ms forever.
 */
export function nextReconnectAttempt(
  attempt: number,
  openedAt: number | null,
  sawTranscript: boolean,
  now = Date.now(),
  stableUptimeMs = 30_000
): number {
  const normalizedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.min(20, Math.floor(attempt)))
    : 0
  const hadStableUptime =
    openedAt !== null && now >= openedAt && now - openedAt >= stableUptimeMs

  if (sawTranscript || hadStableUptime) return 1
  return Math.min(20, normalizedAttempt + 1)
}

export function isPermanentAsrFailure(reason: string): boolean {
  return /(?:\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|invalid subscription key)/i.test(
    reason
  )
}

export type AsrProviderPreference = 'auto' | 'deepgram' | 'sarvam'
export type AsrProviderPlan =
  | { provider: 'deepgram'; allowDeepgramFallback: false }
  | { provider: 'sarvam'; allowDeepgramFallback: boolean }
  | { provider: null; allowDeepgramFallback: false; error: string }

/** Provider choice policy, kept pure so explicit-provider behavior cannot regress. */
export function resolveAsrProviderPlan(
  preference: AsrProviderPreference,
  keys: { sarvam: boolean; deepgram: boolean }
): AsrProviderPlan {
  if (preference === 'deepgram') {
    return keys.deepgram
      ? { provider: 'deepgram', allowDeepgramFallback: false }
      : {
          provider: null,
          allowDeepgramFallback: false,
          error: 'Deepgram key not set (needed for speaker labels)'
        }
  }
  if (preference === 'sarvam') {
    return keys.sarvam
      ? { provider: 'sarvam', allowDeepgramFallback: false }
      : { provider: null, allowDeepgramFallback: false, error: 'Sarvam key not set' }
  }
  if (keys.sarvam) return { provider: 'sarvam', allowDeepgramFallback: keys.deepgram }
  if (keys.deepgram) return { provider: 'deepgram', allowDeepgramFallback: false }
  return {
    provider: null,
    allowDeepgramFallback: false,
    error: 'Speech service not configured'
  }
}

/**
 * Wait until final-transcript activity becomes quiet, or until the hard bound.
 * The caller supplies a revision counter and subscription so the timing policy
 * can be tested without Electron or an ASR provider.
 */
export function waitForFinalTranscriptSettle(
  getRevision: () => number,
  subscribe: (listener: () => void) => () => void,
  timeoutMs: number,
  quietMs = 350
): Promise<FinalTranscriptSettleResult> {
  const initialRevision = getRevision()
  return new Promise((resolve) => {
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = (): void => undefined

    const finish = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(hardTimer)
      unsubscribe()
      resolve({ timedOut, sawFinal: getRevision() !== initialRevision })
    }

    const onFinal = (): void => {
      if (getRevision() === initialRevision) return
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(false), quietMs)
    }

    const hardTimer = setTimeout(() => finish(true), timeoutMs)
    unsubscribe = subscribe(onFinal)
    // Cover a revision change that happened between the first read and subscribe().
    onFinal()
  })
}

/**
 * Owns the identity of each ASR connection independently from the provider.
 *
 * Callbacks must check isCurrent() before changing UI state. A graceful stop
 * marks a slot as intentionally closing without invalidating it, which lets
 * final transcript callbacks through while preventing provider fallbacks. A
 * normal stop or a new start invalidates the generation before closing the old
 * socket, so late close/error callbacks cannot affect the replacement stream.
 */
export class AsrSessionManager<T extends ClosableAsrStream> {
  private readonly slots: Record<AsrKind, Slot<T>> = {
    system: { generation: 0, stream: null, intentionalClose: false },
    mic: { generation: 0, stream: null, intentionalClose: false }
  }

  begin(kind: AsrKind): number {
    const slot = this.slots[kind]
    const previous = slot.stream
    const previousGeneration = slot.generation
    slot.generation += 1
    slot.stream = null
    slot.intentionalClose = false
    previous?.close()
    this.onGenerationEnded?.(kind, previousGeneration)
    return slot.generation
  }

  constructor(
    private readonly onGenerationEnded?: (kind: AsrKind, generation: number) => void
  ) {}

  install(kind: AsrKind, generation: number, stream: T): boolean {
    const slot = this.slots[kind]
    if (slot.generation !== generation || slot.intentionalClose) {
      stream.close()
      return false
    }
    const previous = slot.stream
    slot.stream = stream
    previous?.close()
    return true
  }

  current(kind: AsrKind): T | null {
    return this.slots[kind].stream
  }

  isCurrent(kind: AsrKind, generation: number, stream: T): boolean {
    const slot = this.slots[kind]
    return slot.generation === generation && slot.stream === stream
  }

  isIntentionalClose(kind: AsrKind, generation: number, stream: T): boolean {
    const slot = this.slots[kind]
    return this.isCurrent(kind, generation, stream) && slot.intentionalClose
  }

  canFallback(kind: AsrKind, generation: number, stream: T): boolean {
    return this.isCurrent(kind, generation, stream) && !this.slots[kind].intentionalClose
  }

  clearIfCurrent(kind: AsrKind, generation: number, stream: T): boolean {
    if (!this.isCurrent(kind, generation, stream)) return false
    this.slots[kind].stream = null
    return true
  }

  beginIntentionalClose(kind: AsrKind): AsrSessionSnapshot<T> | null {
    const slot = this.slots[kind]
    if (!slot.stream) return null
    slot.intentionalClose = true
    return { kind, generation: slot.generation, stream: slot.stream }
  }

  closeSnapshot(snapshot: AsrSessionSnapshot<T>): boolean {
    if (!this.isCurrent(snapshot.kind, snapshot.generation, snapshot.stream)) return false
    this.stop(snapshot.kind)
    return true
  }

  stop(kind: AsrKind): void {
    const slot = this.slots[kind]
    const stream = slot.stream
    const previousGeneration = slot.generation
    // Invalidate first: ws.close() can synchronously schedule error/close work.
    slot.generation += 1
    slot.stream = null
    slot.intentionalClose = true
    stream?.close()
    this.onGenerationEnded?.(kind, previousGeneration)
  }

  stopAll(): void {
    this.stop('system')
    this.stop('mic')
  }
}
