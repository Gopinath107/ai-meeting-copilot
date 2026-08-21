import { describe, expect, it } from 'vitest'
import {
  computeHintPlacement,
  HINT_EDGE_MARGIN,
  HINT_GAP,
  HINT_MAX_WIDTH
} from '../src/renderer/src/components/hintPlacement'

// The overlay's default width. Hints must stay inside it — unlike a native
// tooltip, this one cannot escape the window.
const OVERLAY_WIDTH = 460

describe('stealth hint placement', () => {
  it('sits above a control that has room overhead', () => {
    const placement = computeHintPlacement(
      { top: 300, bottom: 322, left: 200, width: 60 },
      OVERLAY_WIDTH
    )

    expect(placement.placement).toBe('above')
    expect(placement.top).toBe(300 - HINT_GAP)
  })

  it('flips below a control near the top edge instead of clipping', () => {
    const placement = computeHintPlacement(
      { top: 8, bottom: 30, left: 200, width: 60 },
      OVERLAY_WIDTH
    )

    expect(placement.placement).toBe('below')
    expect(placement.top).toBe(30 + HINT_GAP)
  })

  it('keeps a hint on a left-edge control inside the window', () => {
    const placement = computeHintPlacement({ top: 300, bottom: 322, left: 0, width: 40 }, OVERLAY_WIDTH)

    expect(placement.left).toBeGreaterThanOrEqual(HINT_EDGE_MARGIN)
  })

  it('keeps a hint on a right-edge control inside the window', () => {
    const placement = computeHintPlacement(
      { top: 300, bottom: 322, left: OVERLAY_WIDTH - 40, width: 40 },
      OVERLAY_WIDTH
    )

    expect(placement.left + placement.maxWidth).toBeLessThanOrEqual(OVERLAY_WIDTH - HINT_EDGE_MARGIN)
  })

  it('narrows the bubble rather than overflowing a very narrow window', () => {
    const narrow = computeHintPlacement({ top: 300, bottom: 322, left: 10, width: 40 }, 200)

    expect(narrow.maxWidth).toBeLessThanOrEqual(200 - HINT_EDGE_MARGIN * 2)
    expect(narrow.left).toBeGreaterThanOrEqual(HINT_EDGE_MARGIN)
    expect(narrow.left + narrow.maxWidth).toBeLessThanOrEqual(200 - HINT_EDGE_MARGIN)
  })

  it('never grows past the readable maximum on a wide window', () => {
    expect(computeHintPlacement({ top: 300, bottom: 322, left: 800, width: 40 }, 1920).maxWidth).toBe(
      HINT_MAX_WIDTH
    )
  })
})
