export type ScreenCaptureHandle = {
  startScreen: () => Promise<boolean>
  stopScreen: () => void
}

export type ScreenAcquisitionOutcome = 'ready' | 'unavailable' | 'stale'

/**
 * Run one live screen-attachment attempt with lifecycle checks around every await.
 * The caller serializes attempts; this function guarantees a cancelled/off/stopped
 * session cannot start or commit a late display stream.
 */
export async function runScreenAcquisitionAttempt({
  capture,
  prepare,
  isCurrent,
  onPending
}: {
  capture: ScreenCaptureHandle
  prepare: () => Promise<boolean>
  isCurrent: () => boolean
  onPending: () => void
}): Promise<ScreenAcquisitionOutcome> {
  onPending()
  if (!isCurrent()) return 'stale'

  const prepared = await prepare()
  if (!isCurrent()) return 'stale'
  if (!prepared) return 'unavailable'

  try {
    const ready = await capture.startScreen()
    if (!isCurrent()) {
      capture.stopScreen()
      return 'stale'
    }
    return ready ? 'ready' : 'unavailable'
  } catch (error) {
    if (!isCurrent()) {
      capture.stopScreen()
      return 'stale'
    }
    throw error
  }
}
