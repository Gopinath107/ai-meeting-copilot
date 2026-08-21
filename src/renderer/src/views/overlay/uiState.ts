import type { CaptureDisplayState } from './TranscriptPanel'

export type HealthTone = 'ready' | 'working' | 'idle' | 'error'

export type HealthItem = {
  label: string
  value: string
  tone: HealthTone
  detail?: string
}

export function statusTone(status: string): HealthTone {
  const normalized = status.trim().toLowerCase()
  if (!normalized || normalized === 'stopped' || normalized === 'closed') return 'idle'
  if (normalized.startsWith('error') || normalized.includes('failed')) return 'error'
  if (
    normalized.startsWith('connecting') ||
    normalized.startsWith('reconnecting') ||
    normalized.startsWith('starting') ||
    normalized.startsWith('finalizing')
  ) {
    return 'working'
  }
  if (normalized.startsWith('connected')) return 'ready'
  return 'idle'
}

export function captureHealth(
  state: CaptureDisplayState,
  error: string | null
): Pick<HealthItem, 'value' | 'tone'> {
  if (error) return { value: 'Failed', tone: 'error' }
  if (state === 'active') return { value: 'Ready', tone: 'ready' }
  if (state === 'starting') return { value: 'Starting', tone: 'working' }
  if (state === 'finalizing') return { value: 'Finalizing', tone: 'working' }
  return { value: 'Stopped', tone: 'idle' }
}

export function speechHealth(
  status: string,
  state: CaptureDisplayState,
  configured: boolean
): Pick<HealthItem, 'value' | 'tone'> {
  if (!configured) return { value: 'Configure', tone: 'error' }
  if (state === 'idle' && statusTone(status) !== 'error') {
    return { value: 'Stopped', tone: 'idle' }
  }
  const tone = statusTone(status)
  const label = status.split(':', 1)[0]?.trim()
  if (tone === 'ready') return { value: 'Connected', tone }
  if (tone === 'working') return { value: label || 'Connecting', tone }
  if (tone === 'error') return { value: 'Failed', tone }
  return { value: state === 'active' ? 'Waiting' : 'Stopped', tone: 'idle' }
}

export function hasSpeechConfiguration(settings: {
  sarvamKeySet: boolean
  deepgramKeySet: boolean
} | null, provider: 'auto' | 'sarvam' | 'deepgram' = 'auto'): boolean {
  if (!settings) return false
  if (provider === 'sarvam') return settings.sarvamKeySet
  if (provider === 'deepgram') return settings.deepgramKeySet
  return settings.sarvamKeySet || settings.deepgramKeySet
}

export function hasAiConfiguration(settings: {
  azureKeySet: boolean
  azureEndpoint: string
  azureDeployment: string
} | null): boolean {
  return Boolean(
    settings?.azureKeySet && settings.azureEndpoint.trim() && settings.azureDeployment.trim()
  )
}
