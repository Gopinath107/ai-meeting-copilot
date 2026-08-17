import { describe, expect, it } from 'vitest'
import { safeExternalHref } from '../src/renderer/src/components/Markdown'

describe('safeExternalHref', () => {
  it.each([
    ['https://example.com/path?q=1', 'https://example.com/path?q=1'],
    ['http://localhost:3000/docs', 'http://localhost:3000/docs'],
    ['mailto:person@example.com', 'mailto:person@example.com']
  ])('allows an explicit safe URL: %s', (input, expected) => {
    expect(safeExternalHref(input)).toBe(expected)
  })

  it.each([
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'data:text/html;base64,SGVsbG8=',
    'ms-settings:privacy',
    '/relative/path',
    '../local-file',
    '#fragment'
  ])('blocks unsafe, custom, or relative URLs: %s', (input) => {
    expect(safeExternalHref(input)).toBeUndefined()
  })

  it('blocks empty and malformed values', () => {
    expect(safeExternalHref()).toBeUndefined()
    expect(safeExternalHref('not a URL')).toBeUndefined()
  })
})
