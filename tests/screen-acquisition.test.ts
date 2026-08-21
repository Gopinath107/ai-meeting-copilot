import { describe, expect, it, vi } from 'vitest'
import { runScreenAcquisitionAttempt } from '../src/renderer/src/views/overlay/screenAcquisition'
import {
  screenSourceControlsDisabled,
  screenToggleDisabled
} from '../src/renderer/src/views/overlay/CaptureControls'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('live screen acquisition', () => {
  it('marks readiness pending before source preparation resolves', async () => {
    const preparation = deferred<boolean>()
    const events: string[] = []
    const capture = { startScreen: vi.fn(async () => true), stopScreen: vi.fn() }
    const attempt = runScreenAcquisitionAttempt({
      capture,
      prepare: () => preparation.promise,
      isCurrent: () => true,
      onPending: () => events.push('pending')
    })

    expect(events).toEqual(['pending'])
    expect(capture.startScreen).not.toHaveBeenCalled()
    preparation.resolve(true)
    await expect(attempt).resolves.toBe('ready')
  })

  it('does not start a screen after cancellation during preparation', async () => {
    const preparation = deferred<boolean>()
    let current = true
    const capture = { startScreen: vi.fn(async () => true), stopScreen: vi.fn() }
    const attempt = runScreenAcquisitionAttempt({
      capture,
      prepare: () => preparation.promise,
      isCurrent: () => current,
      onPending: vi.fn()
    })

    current = false
    preparation.resolve(true)

    await expect(attempt).resolves.toBe('stale')
    expect(capture.startScreen).not.toHaveBeenCalled()
  })

  it('cleans up a late screen result without committing it', async () => {
    const starting = deferred<boolean>()
    let current = true
    const capture = { startScreen: vi.fn(() => starting.promise), stopScreen: vi.fn() }
    const attempt = runScreenAcquisitionAttempt({
      capture,
      prepare: async () => true,
      isCurrent: () => current,
      onPending: vi.fn()
    })
    await vi.waitFor(() => expect(capture.startScreen).toHaveBeenCalledOnce())

    current = false
    starting.resolve(true)

    await expect(attempt).resolves.toBe('stale')
    expect(capture.stopScreen).toHaveBeenCalledOnce()
  })

  it('locks source changes while acquiring but always permits turning an active screen off', () => {
    expect(screenSourceControlsDisabled('active', false, true)).toBe(true)
    expect(screenToggleDisabled('active', true, true)).toBe(false)
    expect(screenToggleDisabled('active', false, true)).toBe(true)
  })
})
