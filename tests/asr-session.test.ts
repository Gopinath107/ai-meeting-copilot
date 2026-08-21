import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AsrSessionManager,
  BoundedPcmBuffer,
  isPermanentAsrFailure,
  nextReconnectAttempt,
  reconnectDelayMs,
  resolveAsrProviderPlan,
  waitForFinalTranscriptSettle
} from '../src/main/asrSession'

class FakeStream {
  closeCount = 0

  close(): void {
    this.closeCount += 1
  }
}

describe('AsrSessionManager', () => {
  it('reports obsolete generations so session bookkeeping can be cleared', () => {
    const ended = vi.fn()
    const sessions = new AsrSessionManager<FakeStream>(ended)
    const generation = sessions.begin('system')
    const stream = new FakeStream()
    sessions.install('system', generation, stream)

    sessions.stop('system')

    expect(ended).toHaveBeenCalledWith('system', generation)
  })

  it('blocks fallback while an intentional close is finalizing', () => {
    const sessions = new AsrSessionManager<FakeStream>()
    const generation = sessions.begin('system')
    const stream = new FakeStream()

    expect(sessions.install('system', generation, stream)).toBe(true)
    const snapshot = sessions.beginIntentionalClose('system')

    expect(snapshot).not.toBeNull()
    expect(sessions.isIntentionalClose('system', generation, stream)).toBe(true)
    expect(sessions.canFallback('system', generation, stream)).toBe(false)
  })

  it('invalidates stale callbacks before replacing or stopping a stream', () => {
    const sessions = new AsrSessionManager<FakeStream>()
    const firstGeneration = sessions.begin('system')
    const first = new FakeStream()
    sessions.install('system', firstGeneration, first)

    const secondGeneration = sessions.begin('system')
    const second = new FakeStream()
    sessions.install('system', secondGeneration, second)

    expect(first.closeCount).toBe(1)
    expect(sessions.isCurrent('system', firstGeneration, first)).toBe(false)
    expect(sessions.canFallback('system', firstGeneration, first)).toBe(false)

    sessions.stop('system')
    expect(second.closeCount).toBe(1)
    expect(sessions.current('system')).toBeNull()
  })

  it('rejects a late stream created for an obsolete generation', () => {
    const sessions = new AsrSessionManager<FakeStream>()
    const obsoleteGeneration = sessions.begin('mic')
    sessions.begin('mic')
    const late = new FakeStream()

    expect(sessions.install('mic', obsoleteGeneration, late)).toBe(false)
    expect(late.closeCount).toBe(1)
  })

  it('can gracefully close one source without invalidating the other', () => {
    const sessions = new AsrSessionManager<FakeStream>()
    const systemGeneration = sessions.begin('system')
    const micGeneration = sessions.begin('mic')
    const system = new FakeStream()
    const mic = new FakeStream()
    sessions.install('system', systemGeneration, system)
    sessions.install('mic', micGeneration, mic)

    const micSnapshot = sessions.beginIntentionalClose('mic')
    expect(micSnapshot).not.toBeNull()
    expect(sessions.closeSnapshot(micSnapshot!)).toBe(true)

    expect(mic.closeCount).toBe(1)
    expect(sessions.current('mic')).toBeNull()
    expect(sessions.current('system')).toBe(system)
    expect(sessions.isCurrent('system', systemGeneration, system)).toBe(true)
  })
})

describe('BoundedPcmBuffer', () => {
  it('keeps the newest bytes and reports audio discarded under backpressure', () => {
    const queue = new BoundedPcmBuffer(6)
    queue.push(Buffer.from([1, 2, 3, 4]))
    queue.push(Buffer.from([5, 6, 7, 8]))

    expect(queue.byteLength).toBe(6)
    expect(Buffer.concat(queue.drain())).toEqual(Buffer.from([3, 4, 5, 6, 7, 8]))
    expect(queue.takeDroppedBytes()).toBe(2)
    expect(queue.takeDroppedBytes()).toBe(0)
  })

  it('caps exponential reconnect delays and supports deterministic jitter', () => {
    expect(reconnectDelayMs(1, () => 0.5)).toBe(500)
    expect(reconnectDelayMs(2, () => 0.5)).toBe(1_000)
    expect(reconnectDelayMs(20, () => 0.5)).toBe(15_000)
  })

  it('continues and caps backoff when a socket only opened briefly', () => {
    expect(nextReconnectAttempt(0, null, false, 50_000)).toBe(1)
    expect(nextReconnectAttempt(4, 49_000, false, 50_000)).toBe(5)
    expect(nextReconnectAttempt(20, 49_000, false, 50_000)).toBe(20)
  })

  it('resets backoff only after useful transcript activity or stable uptime', () => {
    expect(nextReconnectAttempt(8, 49_000, true, 50_000)).toBe(1)
    expect(nextReconnectAttempt(8, 20_000, false, 50_000)).toBe(1)
    expect(nextReconnectAttempt(8, 20_001, false, 50_000)).toBe(9)
  })

  it('distinguishes credential failures from transient network failures', () => {
    expect(isPermanentAsrFailure('Unexpected server response: 401')).toBe(true)
    expect(isPermanentAsrFailure('invalid subscription key')).toBe(true)
    expect(isPermanentAsrFailure('socket hang up')).toBe(false)
  })
})

describe('resolveAsrProviderPlan', () => {
  it('does not silently replace an explicitly selected Sarvam provider', () => {
    expect(
      resolveAsrProviderPlan('sarvam', { sarvam: false, deepgram: true })
    ).toEqual({
      provider: null,
      allowDeepgramFallback: false,
      error: 'Sarvam key not set'
    })
  })

  it('allows Deepgram fallback only for Auto with both keys', () => {
    expect(resolveAsrProviderPlan('auto', { sarvam: true, deepgram: true })).toEqual({
      provider: 'sarvam',
      allowDeepgramFallback: true
    })
    expect(resolveAsrProviderPlan('sarvam', { sarvam: true, deepgram: true })).toEqual({
      provider: 'sarvam',
      allowDeepgramFallback: false
    })
  })
})

describe('waitForFinalTranscriptSettle', () => {
  afterEach(() => vi.useRealTimers())

  it('settles after final transcript activity becomes quiet', async () => {
    vi.useFakeTimers()
    let revision = 0
    const listeners = new Set<() => void>()
    const resultPromise = waitForFinalTranscriptSettle(
      () => revision,
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      1_000,
      100
    )

    revision += 1
    listeners.forEach((listener) => listener())
    await vi.advanceTimersByTimeAsync(100)

    await expect(resultPromise).resolves.toEqual({ timedOut: false, sawFinal: true })
    expect(listeners.size).toBe(0)
  })

  it('returns a bounded timeout when no final transcript arrives', async () => {
    vi.useFakeTimers()
    const resultPromise = waitForFinalTranscriptSettle(
      () => 0,
      () => () => undefined,
      250,
      50
    )

    await vi.advanceTimersByTimeAsync(250)
    await expect(resultPromise).resolves.toEqual({ timedOut: true, sawFinal: false })
  })
})
