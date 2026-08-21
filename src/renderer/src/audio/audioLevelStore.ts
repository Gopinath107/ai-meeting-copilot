import { useCallback, useSyncExternalStore } from 'react'
import type { AudioSourceKind } from '../../../shared/capture'

export type AudioLevelSnapshot = Readonly<Record<AudioSourceKind, number>>

export type AudioLevelStoreOptions = {
  /** Maximum meter publication frequency. Capture callbacks may be much faster. */
  throttleMs?: number
  now?: () => number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}

export type AudioLevelStore = {
  getLevel(kind: AudioSourceKind): number
  getSnapshot(): AudioLevelSnapshot
  subscribe(kind: AudioSourceKind, listener: () => void): () => void
  setLevel(kind: AudioSourceKind, level: number): void
  setLevels(levels: Partial<Record<AudioSourceKind, number>>): void
  /** Publish any queued values synchronously. */
  flush(): void
  /** Cancel a queued publication and immediately publish silence. */
  reset(): void
  dispose(): void
}

const SILENCE: AudioLevelSnapshot = Object.freeze({ system: 0, mic: 0 })

function normalizeLevel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * A tiny external store for high-frequency capture meters.
 *
 * Audio worklet callbacks write here without touching React component state.
 * Only the Meter subscribed to the changed source is notified, at a bounded
 * rate, so the full overlay does not re-render for every PCM worklet message.
 */
export function createAudioLevelStore(options: AudioLevelStoreOptions = {}): AudioLevelStore {
  const throttleMs = Math.max(0, Math.round(options.throttleMs ?? 100))
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const listeners: Record<AudioSourceKind, Set<() => void>> = {
    system: new Set(),
    mic: new Set()
  }
  let published: AudioLevelSnapshot = SILENCE
  let pending: AudioLevelSnapshot = SILENCE
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPublishedAt = Number.NEGATIVE_INFINITY
  let disposed = false

  const publish = (): void => {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
    if (disposed) return
    const changedKinds = (['system', 'mic'] as const).filter(
      (kind) => pending[kind] !== published[kind]
    )
    if (changedKinds.length === 0) return
    published = Object.freeze({ ...pending })
    lastPublishedAt = now()
    for (const kind of changedKinds) {
      for (const listener of [...listeners[kind]]) listener()
    }
  }

  const requestPublish = (): void => {
    if (disposed || timer !== null) return
    const elapsed = now() - lastPublishedAt
    if (elapsed >= throttleMs) {
      publish()
      return
    }
    timer = schedule(publish, Math.max(0, throttleMs - elapsed))
  }

  const store: AudioLevelStore = {
    getLevel: (kind) => published[kind],
    getSnapshot: () => published,
    subscribe: (kind, listener) => {
      if (disposed) return () => undefined
      listeners[kind].add(listener)
      return () => listeners[kind].delete(listener)
    },
    setLevel: (kind, level) => {
      if (disposed) return
      const normalized = normalizeLevel(level)
      if (pending[kind] === normalized) return
      pending = Object.freeze({ ...pending, [kind]: normalized })
      requestPublish()
    },
    setLevels: (levels) => {
      if (disposed) return
      const next = {
        system:
          levels.system === undefined ? pending.system : normalizeLevel(levels.system),
        mic: levels.mic === undefined ? pending.mic : normalizeLevel(levels.mic)
      }
      if (next.system === pending.system && next.mic === pending.mic) return
      pending = Object.freeze(next)
      requestPublish()
    },
    flush: publish,
    reset: () => {
      if (disposed) return
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
      pending = SILENCE
      publish()
    },
    dispose: () => {
      if (timer !== null) cancel(timer)
      timer = null
      disposed = true
      listeners.system.clear()
      listeners.mic.clear()
    }
  }
  return store
}

/** One stable app-level instance that OverlayView can write without React state. */
export const captureAudioLevelStore = createAudioLevelStore()

/** Subscribe one meter to one source; changes to the other source do not render it. */
export function useAudioLevel(store: AudioLevelStore, kind: AudioSourceKind): number {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(kind, listener),
    [kind, store]
  )
  const getSnapshot = useCallback(() => store.getLevel(kind), [kind, store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
