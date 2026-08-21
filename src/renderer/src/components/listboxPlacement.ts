export type ListboxRect = {
  top: number
  bottom: number
  left: number
  width: number
}

export type ListboxViewport = {
  width: number
  height: number
}

export type ListboxPlacement = {
  top: number
  left: number
  width: number
  maxHeight: number
  placement: 'above' | 'below'
}

export const LISTBOX_GAP = 4
export const LISTBOX_EDGE_MARGIN = 6
export const LISTBOX_MIN_WIDTH = 140
export const LISTBOX_MAX_HEIGHT = 240
/** Below this, a list is too short to be worth opening into — flip instead. */
export const LISTBOX_MIN_USABLE_HEIGHT = 96

/**
 * Place an in-overlay dropdown list and keep it fully inside the window.
 *
 * A native <select> popup is its own OS window: it can spill past the app and is
 * exempt from the overlay's capture exclusion. This replacement is ordinary page
 * content, so it is covered by stealth — but it also cannot escape a 460x660
 * window, which is why it must flip and clamp rather than overflow.
 */
export function computeListboxPlacement(
  rect: ListboxRect,
  viewport: ListboxViewport,
  desiredHeight: number
): ListboxPlacement {
  const spaceBelow = viewport.height - rect.bottom - LISTBOX_GAP - LISTBOX_EDGE_MARGIN
  const spaceAbove = rect.top - LISTBOX_GAP - LISTBOX_EDGE_MARGIN

  // Prefer opening downward, but flip when below is unusably short AND above is
  // genuinely roomier — flipping into an equally cramped space helps nobody.
  const placement: ListboxPlacement['placement'] =
    spaceBelow < Math.min(desiredHeight, LISTBOX_MIN_USABLE_HEIGHT) && spaceAbove > spaceBelow
      ? 'above'
      : 'below'

  const available = placement === 'below' ? spaceBelow : spaceAbove
  const maxHeight = Math.max(0, Math.min(desiredHeight, LISTBOX_MAX_HEIGHT, available))

  const width = Math.max(
    Math.min(Math.max(rect.width, LISTBOX_MIN_WIDTH), viewport.width - LISTBOX_EDGE_MARGIN * 2),
    0
  )
  const rightLimit = Math.max(LISTBOX_EDGE_MARGIN, viewport.width - width - LISTBOX_EDGE_MARGIN)

  return {
    placement,
    top: placement === 'below' ? rect.bottom + LISTBOX_GAP : rect.top - LISTBOX_GAP - maxHeight,
    left: Math.min(Math.max(LISTBOX_EDGE_MARGIN, rect.left), rightLimit),
    width,
    maxHeight
  }
}
