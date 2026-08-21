/**
 * Which secondary panels are folded away, so the AI answer can own the height.
 *
 * The overlay is a small always-on-top window (460x660 by default) on what is
 * often a scaled laptop panel. Status pills, capture controls and the transcript
 * are all useful while you set a session up, but during the session the answer is
 * the only thing you actually read — and it was getting the least room.
 */
export const OVERLAY_PANEL_KEYS = ['health', 'controls', 'transcript'] as const

export type OverlayPanelKey = (typeof OVERLAY_PANEL_KEYS)[number]

export type OverlayPanelState = Readonly<Record<OverlayPanelKey, boolean>>

export const EXPANDED_PANELS: OverlayPanelState = {
  health: false,
  controls: false,
  transcript: false
}

/** Focus mode: everything optional folded away, answer pane at full height. */
export const FOCUSED_PANELS: OverlayPanelState = {
  health: true,
  controls: true,
  transcript: true
}

const STORAGE_KEY = 'overlay.collapsedPanels.v1'

export function isPanelCollapsed(state: OverlayPanelState, key: OverlayPanelKey): boolean {
  return state[key] === true
}

export function togglePanel(state: OverlayPanelState, key: OverlayPanelKey): OverlayPanelState {
  return { ...state, [key]: !state[key] }
}

/** Focus mode is on only when every optional panel is folded away. */
export function isFocusMode(state: OverlayPanelState): boolean {
  return OVERLAY_PANEL_KEYS.every((key) => state[key])
}

/**
 * Toggling focus off restores every panel rather than replaying whatever was
 * collapsed beforehand: after an interview you want the full window back, and a
 * half-restored layout reads as a bug.
 */
export function toggleFocusMode(state: OverlayPanelState): OverlayPanelState {
  return isFocusMode(state) ? EXPANDED_PANELS : FOCUSED_PANELS
}

export function normalizeOverlayPanelState(value: unknown): OverlayPanelState {
  if (typeof value !== 'object' || value === null) return EXPANDED_PANELS
  const record = value as Record<string, unknown>
  return {
    health: record.health === true,
    controls: record.controls === true,
    transcript: record.transcript === true
  }
}

/**
 * Persistence is a convenience, never a requirement. Every accessor is guarded:
 * storage can be disabled or throw outright, and the overlay must still open.
 */
export function readOverlayPanelState(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage()
): OverlayPanelState {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    return raw ? normalizeOverlayPanelState(JSON.parse(raw)) : EXPANDED_PANELS
  } catch {
    return EXPANDED_PANELS
  }
}

export function writeOverlayPanelState(
  state: OverlayPanelState,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A remembered layout is not worth failing a session over.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}
