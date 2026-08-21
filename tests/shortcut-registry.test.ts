import { describe, expect, it, vi } from 'vitest'
import { registerShortcutSet } from '../src/main/shortcutRegistry'

describe('registerShortcutSet', () => {
  it('reports conflicts without hiding healthy shortcut registrations', () => {
    const unregister = vi.fn()
    const register = vi
      .fn<(accelerator: string, handler: () => void) => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)

    const health = registerShortcutSet(
      { register, unregister },
      [
        { id: 'toggle-overlay', label: 'Toggle', accelerator: 'Ctrl+A', handler: vi.fn() },
        { id: 'ask', label: 'Ask', accelerator: 'Ctrl+B', handler: vi.fn() }
      ],
      () => 123
    )

    expect(unregister).toHaveBeenCalledTimes(2)
    expect(health).toMatchObject({ registered: 1, total: 2, allRegistered: false, checkedAt: 123 })
    expect(health.shortcuts[1]).toMatchObject({
      registered: false,
      error: 'Shortcut is already in use by Windows or another application'
    })
  })

  it('turns thrown platform errors into health details', () => {
    const health = registerShortcutSet(
      {
        unregister: vi.fn(),
        register: () => {
          throw new Error('unsupported accelerator')
        }
      },
      [{ id: 'hide-overlay', label: 'Hide', accelerator: 'BadKey', handler: vi.fn() }]
    )

    expect(health.shortcuts[0]).toMatchObject({
      registered: false,
      error: 'unsupported accelerator'
    })
  })
})
