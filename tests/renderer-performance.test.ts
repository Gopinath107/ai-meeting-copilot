import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAudioLevelStore } from '../src/renderer/src/audio/audioLevelStore'
import {
  createAiTokenRenderBatcher,
  type AiTokenRenderBatch
} from '../src/renderer/src/views/overlay/aiTokenBatcher'

describe('audio level external store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })

  afterEach(() => vi.useRealTimers())

  it('publishes immediately, then coalesces rapid worklet updates per source', async () => {
    const store = createAudioLevelStore({ throttleMs: 100 })
    const onSystem = vi.fn()
    const onMic = vi.fn()
    store.subscribe('system', onSystem)
    store.subscribe('mic', onMic)

    store.setLevel('system', 0.1)
    expect(store.getSnapshot()).toEqual({ system: 0.1, mic: 0 })
    expect(onSystem).toHaveBeenCalledTimes(1)

    store.setLevel('system', 0.2)
    store.setLevel('system', 0.3)
    store.setLevel('mic', 0.4)
    expect(store.getSnapshot()).toEqual({ system: 0.1, mic: 0 })

    await vi.advanceTimersByTimeAsync(100)
    expect(store.getSnapshot()).toEqual({ system: 0.3, mic: 0.4 })
    expect(onSystem).toHaveBeenCalledTimes(2)
    expect(onMic).toHaveBeenCalledTimes(1)
  })

  it('clamps invalid input and reset prevents a queued stale level from publishing', async () => {
    const store = createAudioLevelStore({ throttleMs: 100 })
    store.setLevels({ system: 2, mic: Number.NaN })
    expect(store.getSnapshot()).toEqual({ system: 1, mic: 0 })

    store.setLevel('system', 0.8)
    store.reset()
    expect(store.getSnapshot()).toEqual({ system: 0, mic: 0 })

    await vi.advanceTimersByTimeAsync(200)
    expect(store.getSnapshot()).toEqual({ system: 0, mic: 0 })
  })

  it('returns a stable snapshot and does not notify for unchanged values', () => {
    const store = createAudioLevelStore()
    const listener = vi.fn()
    store.subscribe('system', listener)
    const before = store.getSnapshot()

    store.setLevel('system', 0)

    expect(store.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('AI token render batcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('turns many token fragments into one visible render batch', async () => {
    const batches: AiTokenRenderBatch[] = []
    const batcher = createAiTokenRenderBatcher((batch) => batches.push(batch))

    batcher.enqueue('request-1', 'answer', 'Hel')
    batcher.enqueue('request-1', 'answer', 'lo')
    batcher.enqueue('request-1', 'answer', '!')

    expect(batcher.pendingCharacters()).toBe(6)
    await vi.advanceTimersByTimeAsync(31)
    expect(batches).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(batches).toEqual([
      { requestId: 'request-1', channel: 'answer', text: 'Hello!' }
    ])
    expect(batcher.pendingCharacters()).toBe(0)
  })

  it('keeps request and output channels isolated', async () => {
    const batches: AiTokenRenderBatch[] = []
    const batcher = createAiTokenRenderBatcher((batch) => batches.push(batch))

    batcher.enqueue('request-1', 'analysis', 'analysis')
    batcher.enqueue('request-1', 'minutes', 'minutes')
    batcher.enqueue('request-2', 'answer', 'answer')
    await vi.advanceTimersByTimeAsync(32)

    expect(batches).toEqual([
      { requestId: 'request-1', channel: 'analysis', text: 'analysis' },
      { requestId: 'request-1', channel: 'minutes', text: 'minutes' },
      { requestId: 'request-2', channel: 'answer', text: 'answer' }
    ])
  })

  it('can synchronously flush a completed request without flushing another', async () => {
    const batches: AiTokenRenderBatch[] = []
    const batcher = createAiTokenRenderBatcher((batch) => batches.push(batch))
    batcher.enqueue('done', 'answer', 'complete')
    batcher.enqueue('still-running', 'consultant', 'pending')

    batcher.flush('done')
    expect(batches).toEqual([
      { requestId: 'done', channel: 'answer', text: 'complete' }
    ])
    expect(batcher.pendingCharacters()).toBe(7)

    await vi.advanceTimersByTimeAsync(32)
    expect(batches.at(-1)).toEqual({
      requestId: 'still-running',
      channel: 'consultant',
      text: 'pending'
    })
  })

  it('discards cancelled requests before they can paint stale text', async () => {
    const onBatch = vi.fn()
    const batcher = createAiTokenRenderBatcher(onBatch)
    batcher.enqueue('cancelled', 'answer', 'stale')

    batcher.discard('cancelled')
    await vi.advanceTimersByTimeAsync(64)

    expect(onBatch).not.toHaveBeenCalled()
    expect(batcher.pendingCharacters()).toBe(0)
  })
})
