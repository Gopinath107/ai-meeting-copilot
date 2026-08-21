import { describe, expect, it } from 'vitest'
import {
  EXPANDED_PANELS,
  FOCUSED_PANELS,
  isFocusMode,
  normalizeOverlayPanelState,
  readOverlayPanelState,
  toggleFocusMode,
  togglePanel,
  writeOverlayPanelState
} from '../src/renderer/src/views/overlay/layoutPreferences'

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    read: () => [...map.entries()]
  }
}

describe('overlay panel layout', () => {
  it('starts fully expanded and folds one panel at a time', () => {
    expect(isFocusMode(EXPANDED_PANELS)).toBe(false)

    const transcriptHidden = togglePanel(EXPANDED_PANELS, 'transcript')
    expect(transcriptHidden.transcript).toBe(true)
    expect(transcriptHidden.health).toBe(false)
    expect(transcriptHidden.controls).toBe(false)
  })

  it('treats focus mode as every optional panel folded away', () => {
    expect(isFocusMode(FOCUSED_PANELS)).toBe(true)
    expect(isFocusMode(togglePanel(FOCUSED_PANELS, 'health'))).toBe(false)
  })

  it('restores every panel when focus mode is switched off', () => {
    const partiallyCollapsed = togglePanel(EXPANDED_PANELS, 'health')

    // Turning focus ON from any starting point folds everything away.
    expect(toggleFocusMode(partiallyCollapsed)).toEqual(FOCUSED_PANELS)
    // Turning it OFF gives the whole window back rather than a half-restored layout.
    expect(toggleFocusMode(FOCUSED_PANELS)).toEqual(EXPANDED_PANELS)
  })

  it('round-trips through storage', () => {
    const storage = memoryStorage()
    writeOverlayPanelState(FOCUSED_PANELS, storage)

    expect(readOverlayPanelState(storage)).toEqual(FOCUSED_PANELS)
  })

  it('falls back to an expanded layout for missing, corrupt, or hostile state', () => {
    expect(readOverlayPanelState(memoryStorage())).toEqual(EXPANDED_PANELS)
    expect(readOverlayPanelState(memoryStorage({ 'overlay.collapsedPanels.v1': '{oops' }))).toEqual(
      EXPANDED_PANELS
    )
    expect(normalizeOverlayPanelState(null)).toEqual(EXPANDED_PANELS)
    expect(normalizeOverlayPanelState('focused')).toEqual(EXPANDED_PANELS)
    expect(normalizeOverlayPanelState({ transcript: 'yes', health: 1 })).toEqual(EXPANDED_PANELS)
  })

  it('never lets unavailable storage break the overlay', () => {
    const throwing = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      }
    }

    expect(readOverlayPanelState(throwing)).toEqual(EXPANDED_PANELS)
    expect(() => writeOverlayPanelState(FOCUSED_PANELS, throwing)).not.toThrow()
    expect(readOverlayPanelState(undefined)).toEqual(EXPANDED_PANELS)
  })
})
