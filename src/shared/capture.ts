export type DisplaySourceInfo = {
  id: string
  name: string
  displayId: string
  isPrimary: boolean
  isSelected: boolean
  /** Small local-only preview returned by desktopCapturer for source confirmation. */
  thumbnailDataUrl?: string
  /** Best-effort warning for a protected, black, or otherwise uniform preview. */
  isLikelyBlank?: boolean
}

export type ShortcutId = 'toggle-overlay' | 'hide-overlay' | 'click-through' | 'ask'

export type ShortcutRegistration = {
  id: ShortcutId
  label: string
  accelerator: string
  registered: boolean
  error?: string
}

export type ShortcutHealth = {
  registered: number
  total: number
  allRegistered: boolean
  checkedAt: number
  shortcuts: ShortcutRegistration[]
}

export type TranscriptSource = 'interviewer' | 'you'
export type SpeechConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'stopped'

export type TranscriptStatus = {
  source: TranscriptSource
  status: SpeechConnectionState
  message?: string
  provider?: 'deepgram' | 'sarvam'
  attempt?: number
  updatedAt: number
}

export type SpeechHealth = {
  interviewer: TranscriptStatus
  you: TranscriptStatus
}

export type SpeechSourceStartResult = {
  source: TranscriptSource
  state: 'connected' | 'error'
  provider?: 'deepgram' | 'sarvam'
  message?: string
}

export type SpeechStartResult = {
  ready: boolean
  sources: SpeechSourceStartResult[]
}

export type AudioSourceKind = 'system' | 'mic'

export type AudioStopResult = {
  timedOut: boolean
  waitedMs: number
  finalizedKinds: AudioSourceKind[]
}

export type PickedDocs = {
  names: string[]
  text: string
  warnings: string[]
}
