import { describe, expect, it } from 'vitest'
import { isLikelyBlankFrame } from '../src/renderer/src/audio/screenDiagnostics'
import { isLikelyTranscriptNoise } from '../src/renderer/src/views/overlay/transcriptSafety'
import {
  hasAiConfiguration,
  hasSpeechConfiguration,
  statusTone
} from '../src/renderer/src/views/overlay/uiState'

describe('transcript noise safety', () => {
  it('keeps valid short technical terms', () => {
    for (const term of ['C', 'R', 'Go', 'AI', 'UI']) {
      expect(isLikelyTranscriptNoise(term)).toBe(false)
    }
  })

  it('still rejects known silence hallucinations', () => {
    expect(isLikelyTranscriptNoise('Thanks for watching.')).toBe(true)
    expect(isLikelyTranscriptNoise('[music]')).toBe(true)
    expect(isLikelyTranscriptNoise('um')).toBe(true)
  })
})

describe('screen diagnostics', () => {
  it('flags opaque all-black frames', () => {
    const black = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255])
    expect(isLikelyBlankFrame(black)).toBe(true)
  })

  it('keeps frames with visible contrast', () => {
    const contrast = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    expect(isLikelyBlankFrame(contrast)).toBe(false)
  })
})

describe('health status helpers', () => {
  it('does not show closed or stopped providers as healthy', () => {
    expect(statusTone('closed')).toBe('idle')
    expect(statusTone('stopped')).toBe('idle')
    expect(statusTone('connected: Sarvam')).toBe('ready')
    expect(statusTone('reconnecting')).toBe('working')
    expect(statusTone('error: unauthorized')).toBe('error')
  })

  it('requires a complete provider configuration', () => {
    expect(hasSpeechConfiguration({ sarvamKeySet: true, deepgramKeySet: false })).toBe(true)
    expect(hasSpeechConfiguration({ sarvamKeySet: false, deepgramKeySet: false })).toBe(false)
    expect(
      hasSpeechConfiguration({ sarvamKeySet: true, deepgramKeySet: false }, 'deepgram')
    ).toBe(false)
    expect(
      hasSpeechConfiguration({ sarvamKeySet: false, deepgramKeySet: true }, 'sarvam')
    ).toBe(false)
    expect(
      hasAiConfiguration({
        azureKeySet: true,
        azureEndpoint: 'https://example.openai.azure.com',
        azureDeployment: 'model'
      })
    ).toBe(true)
    expect(
      hasAiConfiguration({ azureKeySet: true, azureEndpoint: '', azureDeployment: 'model' })
    ).toBe(false)
  })
})
