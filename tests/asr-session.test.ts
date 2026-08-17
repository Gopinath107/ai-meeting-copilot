import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsrSessionManager, waitForFinalTranscriptSettle } from '../src/main/asrSession'

class FakeStream {
  closeCount = 0

  close(): void {
    this.closeCount += 1
  }
}

describe('AsrSessionManager', () => {
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
