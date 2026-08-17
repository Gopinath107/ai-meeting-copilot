import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'unused-test-path' } }))

import {
  persistSettingsAtomically,
  type SettingsPersistence
} from '../src/main/settings'

describe('persistSettingsAtomically', () => {
  it('writes a temporary file before replacing the destination', () => {
    const calls: string[] = []
    const persistence: SettingsPersistence = {
      write: (path, contents) => calls.push(`write:${path}:${contents}`),
      replace: (temporary, destination) => calls.push(`replace:${temporary}:${destination}`),
      remove: (path) => calls.push(`remove:${path}`)
    }

    persistSettingsAtomically('settings.json', { azureEndpoint: 'https://example.test' }, persistence)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatch(/^write:settings\.json\.\d+\.\d+\.tmp:/)
    expect(calls[0]).toContain('https://example.test')
    expect(calls[1]).toMatch(/^replace:settings\.json\.\d+\.\d+\.tmp:settings\.json$/)
  })

  it('removes the temporary file and reports a replace failure', () => {
    let temporaryPath = ''
    const remove = vi.fn()
    const persistence: SettingsPersistence = {
      write: (path) => {
        temporaryPath = path
      },
      replace: () => {
        throw new Error('replace denied')
      },
      remove
    }

    expect(() => persistSettingsAtomically('settings.json', {}, persistence)).toThrow(
      'replace denied'
    )
    expect(remove).toHaveBeenCalledWith(temporaryPath)
  })
})
