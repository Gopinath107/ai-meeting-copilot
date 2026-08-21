export type HintPlacement = {
  top: number
  left: number
  maxWidth: number
  placement: 'above' | 'below'
}

export type HintRect = {
  top: number
  bottom: number
  left: number
  width: number
}

export const HINT_GAP = 6
export const HINT_EDGE_MARGIN = 6
/** Below this much room overhead, a hint above the control would be clipped. */
export const HINT_MIN_TOP_FOR_ABOVE = 64
export const HINT_MIN_WIDTH = 120
export const HINT_MAX_WIDTH = 280

/**
 * Place a hint bubble near its control and keep it fully inside the overlay.
 *
 * The overlay window is narrow (460px by default), so a hint centred under a
 * control at either edge would otherwise overflow — and unlike a native tooltip,
 * this one cannot escape the window to stay readable.
 */
export function computeHintPlacement(rect: HintRect, viewportWidth: number): HintPlacement {
  const maxWidth = Math.max(
    HINT_MIN_WIDTH,
    Math.min(HINT_MAX_WIDTH, viewportWidth - HINT_EDGE_MARGIN * 2)
  )
  const placement: HintPlacement['placement'] =
    rect.top >= HINT_MIN_TOP_FOR_ABOVE ? 'above' : 'below'
  const centred = rect.left + rect.width / 2 - maxWidth / 2
  const rightLimit = Math.max(HINT_EDGE_MARGIN, viewportWidth - maxWidth - HINT_EDGE_MARGIN)

  return {
    placement,
    top: placement === 'above' ? rect.top - HINT_GAP : rect.bottom + HINT_GAP,
    left: Math.min(Math.max(HINT_EDGE_MARGIN, centred), rightLimit),
    maxWidth
  }
}
