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
    slot.generation += 1
    slot.stream = null
    slot.intentionalClose = false
    previous?.close()
    return slot.generation
  }

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
    // Invalidate first: ws.close() can synchronously schedule error/close work.
    slot.generation += 1
    slot.stream = null
    slot.intentionalClose = true
    stream?.close()
  }

  stopAll(): void {
    this.stop('system')
    this.stop('mic')
  }
}
