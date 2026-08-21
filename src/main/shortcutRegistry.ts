import type { ShortcutHealth, ShortcutId } from '../shared/capture'

export type ShortcutSpec = {
  id: ShortcutId
  label: string
  accelerator: string
  handler: () => void
}

export type ShortcutRegistrar = {
  register: (accelerator: string, handler: () => void) => boolean
  unregister: (accelerator: string) => void
}

/** Register a complete shortcut set and retain a user-facing result for each key. */
export function registerShortcutSet(
  registrar: ShortcutRegistrar,
  definitions: ShortcutSpec[],
  now: () => number = Date.now
): ShortcutHealth {
  for (const definition of definitions) {
    try {
      registrar.unregister(definition.accelerator)
    } catch {
      // Registration below records any invalid accelerator in a useful form.
    }
  }

  const shortcuts = definitions.map((definition) => {
    try {
      const registered = registrar.register(definition.accelerator, definition.handler)
      return {
        id: definition.id,
        label: definition.label,
        accelerator: definition.accelerator,
        registered,
        ...(!registered
          ? { error: 'Shortcut is already in use by Windows or another application' }
          : {})
      }
    } catch (error) {
      return {
        id: definition.id,
        label: definition.label,
        accelerator: definition.accelerator,
        registered: false,
        error: error instanceof Error ? error.message : 'Invalid shortcut'
      }
    }
  })
  const registered = shortcuts.filter((shortcut) => shortcut.registered).length
  return {
    registered,
    total: shortcuts.length,
    allRegistered: registered === shortcuts.length,
    checkedAt: now(),
    shortcuts
  }
}
