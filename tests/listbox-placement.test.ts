import { describe, expect, it } from 'vitest'
import {
  computeListboxPlacement,
  LISTBOX_EDGE_MARGIN,
  LISTBOX_GAP,
  LISTBOX_MAX_HEIGHT,
  LISTBOX_MIN_WIDTH
} from '../src/renderer/src/components/listboxPlacement'

// The overlay's default size. Unlike a native <select> popup, this list is page
// content and cannot spill outside the window.
const OVERLAY = { width: 460, height: 660 }

describe('stealth listbox placement', () => {
  it('opens below a trigger with room underneath', () => {
    const placement = computeListboxPlacement(
      { top: 100, bottom: 122, left: 40, width: 160 },
      OVERLAY,
      90
    )

    expect(placement.placement).toBe('below')
    expect(placement.top).toBe(122 + LISTBOX_GAP)
  })

  it('flips above a trigger near the bottom edge', () => {
    const placement = computeListboxPlacement(
      { top: 600, bottom: 630, left: 40, width: 160 },
      OVERLAY,
      120
    )

    expect(placement.placement).toBe('above')
    // Grows upward from the trigger, so its bottom edge stays above the control.
    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(600 - LISTBOX_GAP)
    expect(placement.top).toBeGreaterThanOrEqual(0)
  })

  it('stays below when flipping would be no roomier', () => {
    // Cramped on both sides: flipping into an equally short space helps nobody.
    const placement = computeListboxPlacement(
      { top: 20, bottom: 44, left: 40, width: 160 },
      { width: 460, height: 120 },
      200
    )

    expect(placement.placement).toBe('below')
  })

  it('never renders taller than the space it has', () => {
    const placement = computeListboxPlacement(
      { top: 560, bottom: 584, left: 40, width: 160 },
      OVERLAY,
      400
    )

    const bottom = placement.top + placement.maxHeight
    expect(bottom).toBeLessThanOrEqual(OVERLAY.height - LISTBOX_EDGE_MARGIN)
    expect(placement.maxHeight).toBeLessThanOrEqual(LISTBOX_MAX_HEIGHT)
  })

  it('caps a long option list at the readable maximum', () => {
    expect(
      computeListboxPlacement({ top: 40, bottom: 64, left: 40, width: 160 }, OVERLAY, 2000).maxHeight
    ).toBe(LISTBOX_MAX_HEIGHT)
  })

  it('keeps a list anchored to a right-edge trigger inside the window', () => {
    const placement = computeListboxPlacement(
      { top: 100, bottom: 122, left: OVERLAY.width - 60, width: 60 },
      OVERLAY,
      90
    )

    expect(placement.left + placement.width).toBeLessThanOrEqual(
      OVERLAY.width - LISTBOX_EDGE_MARGIN
    )
    expect(placement.left).toBeGreaterThanOrEqual(LISTBOX_EDGE_MARGIN)
  })

  it('widens a narrow trigger to a readable minimum', () => {
    expect(
      computeListboxPlacement({ top: 100, bottom: 122, left: 40, width: 50 }, OVERLAY, 90).width
    ).toBe(LISTBOX_MIN_WIDTH)
  })
})
