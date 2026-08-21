export type AiRenderChannel = 'answer' | 'analysis' | 'consultant' | 'minutes'

export type AiTokenRenderBatch = {
  requestId: string
  channel: AiRenderChannel
  text: string
}

export type AiTokenRenderBatcherOptions = {
  /** Roughly 30 frames/second by default, instead of one render per network token. */
  intervalMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}

export type AiTokenRenderBatcher = {
  enqueue(requestId: string, channel: AiRenderChannel, text: string): void
  /** Flush one request, or every request when requestId is omitted. */
  flush(requestId?: string): void
  /** Drop one obsolete request without rendering it. */
  discard(requestId: string): void
  clear(): void
  dispose(): void
  pendingCharacters(): number
}

type PendingChannels = Map<AiRenderChannel, string>

/**
 * Coalesces streamed AI token fragments into short render batches. Accumulator
 * refs should still be updated synchronously by the caller; this only batches
 * the React setState calls that paint visible text.
 */
export function createAiTokenRenderBatcher(
  onBatch: (batch: AiTokenRenderBatch) => void,
  options: AiTokenRenderBatcherOptions = {}
): AiTokenRenderBatcher {
  const intervalMs = Math.max(0, Math.round(options.intervalMs ?? 32))
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle))
  const pending = new Map<string, PendingChannels>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const cancelTimerIfEmpty = (): void => {
    if (pending.size !== 0 || timer === null) return
    cancel(timer)
    timer = null
  }

  const takeBatches = (requestId?: string): AiTokenRenderBatch[] => {
    const batches: AiTokenRenderBatch[] = []
    const requests = requestId === undefined
      ? [...pending.entries()]
      : pending.has(requestId)
        ? [[requestId, pending.get(requestId)!] as const]
        : []
    for (const [id, channels] of requests) {
      pending.delete(id)
      for (const [channel, text] of channels) {
        if (text) batches.push({ requestId: id, channel, text })
      }
    }
    return batches
  }

  const emit = (requestId?: string): void => {
    if (disposed) return
    if (requestId === undefined && timer !== null) {
      cancel(timer)
      timer = null
    }
    const batches = takeBatches(requestId)
    cancelTimerIfEmpty()
    for (const batch of batches) onBatch(batch)
  }

  const scheduleFlush = (): void => {
    if (disposed || timer !== null) return
    timer = schedule(() => {
      timer = null
      emit()
    }, intervalMs)
  }

  return {
    enqueue: (requestId, channel, text) => {
      if (disposed || !requestId || !text) return
      const channels = pending.get(requestId) ?? new Map<AiRenderChannel, string>()
      channels.set(channel, (channels.get(channel) ?? '') + text)
      pending.set(requestId, channels)
      scheduleFlush()
    },
    flush: emit,
    discard: (requestId) => {
      pending.delete(requestId)
      cancelTimerIfEmpty()
    },
    clear: () => {
      pending.clear()
      cancelTimerIfEmpty()
    },
    dispose: () => {
      if (timer !== null) cancel(timer)
      timer = null
      pending.clear()
      disposed = true
    },
    pendingCharacters: () => {
      let count = 0
      for (const channels of pending.values()) {
        for (const text of channels.values()) count += text.length
      }
      return count
    }
  }
}
