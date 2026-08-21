import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiAskRequest,
  AiDoneEvent,
  AiErrorEvent,
  AiTokenEvent
} from '../shared/ai'
import type {
  AudioSourceKind,
  AudioStopResult,
  DisplaySourceInfo,
  PickedDocs,
  ShortcutHealth,
  SpeechHealth,
  SpeechStartResult,
  TranscriptSource,
  TranscriptStatus
} from '../shared/capture'
import type { ReleaseRuntimeInfo, UpdateStatus } from '../shared/release'
export type {
  AudioSourceKind,
  AudioStopResult,
  DisplaySourceInfo,
  PickedDocs,
  ShortcutHealth,
  SpeechHealth,
  SpeechStartResult,
  TranscriptSource,
  TranscriptStatus
} from '../shared/capture'
export type { BuildMetadata, ReleaseRuntimeInfo, UpdateStatus } from '../shared/release'

export type HotkeyPayload = { action: string; value?: unknown }
export type KeyStatus = { deepgram: boolean; azureOpenAI: boolean }
export type TranscriptUpdate = {
  source: TranscriptSource
  text: string
  isFinal: boolean
  speaker?: number
  confidence?: number
}
export type SettingsStatus = {
  sarvamKeySet: boolean
  deepgramKeySet: boolean
  azureKeySet: boolean
  azureEndpoint: string
  azureDeployment: string
  azureApiVersion: string
  allowInsecureTls: boolean
}
export type SettingsInput = {
  sarvamApiKey?: string
  deepgramApiKey?: string
  azureApiKey?: string
  azureEndpoint?: string
  azureDeployment?: string
  azureApiVersion?: string
  allowInsecureTls?: boolean
  clearSarvamApiKey?: boolean
  clearDeepgramApiKey?: boolean
  clearAzureApiKey?: boolean
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  getReleaseInfo: (): Promise<ReleaseRuntimeInfo> => ipcRenderer.invoke('release:getInfo'),
  getUpdateStatus: (): Promise<UpdateStatus | null> => ipcRenderer.invoke('updates:getStatus'),
  checkForUpdates: (): Promise<boolean> => ipcRenderer.invoke('updates:check'),
  checkForRollback: (): Promise<boolean> => ipcRenderer.invoke('updates:checkRollback'),
  downloadUpdate: (): Promise<boolean> => ipcRenderer.invoke('updates:download'),
  installDownloadedUpdate: (): Promise<boolean> => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: UpdateStatus): void => callback(status)
    ipcRenderer.on('updates:status', listener)
    return () => ipcRenderer.removeListener('updates:status', listener)
  },
  hasKeys: (): Promise<KeyStatus> => ipcRenderer.invoke('app:hasKeys'),
  getShortcutHealth: (): Promise<ShortcutHealth> => ipcRenderer.invoke('shortcuts:getHealth'),
  retryShortcuts: (): Promise<ShortcutHealth> => ipcRenderer.invoke('shortcuts:retry'),
  onShortcutHealthChanged: (callback: (health: ShortcutHealth) => void): (() => void) => {
    const listener = (_event: unknown, health: ShortcutHealth): void => callback(health)
    ipcRenderer.on('shortcuts:status', listener)
    return () => ipcRenderer.removeListener('shortcuts:status', listener)
  },
  getSpeechHealth: (): Promise<SpeechHealth> => ipcRenderer.invoke('speech:getHealth'),
  getSettings: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:get'),
  saveSettings: (input: SettingsInput): Promise<SettingsStatus> =>
    ipcRenderer.invoke('settings:save', input),
  pickDocument: (kind: 'resume' | 'extra'): Promise<PickedDocs | null> =>
    ipcRenderer.invoke('docs:pick', kind),
  listDisplaySources: (): Promise<DisplaySourceInfo[]> =>
    ipcRenderer.invoke('display:listSources'),
  selectDisplaySource: (sourceId: string): Promise<DisplaySourceInfo> =>
    ipcRenderer.invoke('display:selectSource', sourceId),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text),
  hide: (): void => ipcRenderer.send('window:hide'),
  quit: (): void => ipcRenderer.send('window:quit'),
  setClickThrough: (value: boolean): void => ipcRenderer.send('window:setClickThrough', value),
  onHotkey: (callback: (payload: HotkeyPayload) => void): (() => void) => {
    const listener = (_event: unknown, payload: HotkeyPayload): void => callback(payload)
    ipcRenderer.on('hotkey', listener)
    return () => ipcRenderer.removeListener('hotkey', listener)
  },
  sendAudioChunk: (kind: 'system' | 'mic', buffer: ArrayBuffer): void =>
    ipcRenderer.send('audio:chunk', kind, buffer),
  audioStart: (
    mic: boolean,
    provider?: 'auto' | 'deepgram' | 'sarvam',
    keyterms?: string[]
  ): Promise<SpeechStartResult> =>
    ipcRenderer.invoke('audio:start', mic, provider ?? 'auto', keyterms ?? []),
  audioSetMic: (enabled: boolean): void => ipcRenderer.send('audio:setMic', enabled),
  audioStop: (): void => ipcRenderer.send('audio:stop'),
  audioStopGracefully: (timeoutMs = 1800): Promise<AudioStopResult> =>
    ipcRenderer.invoke('audio:stopGracefully', timeoutMs),
  audioStopSourceGracefully: (
    kind: AudioSourceKind,
    timeoutMs = 1800
  ): Promise<AudioStopResult> =>
    ipcRenderer.invoke('audio:stopSourceGracefully', kind, timeoutMs),
  onAudioStats: (callback: (stats: { system: number; mic: number }) => void): (() => void) => {
    const listener = (_event: unknown, stats: { system: number; mic: number }): void =>
      callback(stats)
    ipcRenderer.on('audio:stats', listener)
    return () => ipcRenderer.removeListener('audio:stats', listener)
  },
  onTranscript: (callback: (data: TranscriptUpdate) => void): (() => void) => {
    const listener = (_event: unknown, data: TranscriptUpdate): void => callback(data)
    ipcRenderer.on('transcript:update', listener)
    return () => ipcRenderer.removeListener('transcript:update', listener)
  },
  onTranscriptStatus: (callback: (data: TranscriptStatus) => void): (() => void) => {
    const listener = (_event: unknown, data: TranscriptStatus): void => callback(data)
    ipcRenderer.on('transcript:status', listener)
    return () => ipcRenderer.removeListener('transcript:status', listener)
  },
  setStealth: (value: boolean): void => ipcRenderer.send('window:setStealth', value),
  getStealth: (): Promise<boolean> => ipcRenderer.invoke('window:getStealth'),
  onStealthChanged: (callback: (value: boolean) => void): (() => void) => {
    const listener = (_event: unknown, value: boolean): void => callback(value)
    ipcRenderer.on('stealth:changed', listener)
    return () => ipcRenderer.removeListener('stealth:changed', listener)
  },
  hasAiConfig: (): Promise<boolean> => ipcRenderer.invoke('ai:hasConfig'),
  aiAsk: (request: AiAskRequest): void => ipcRenderer.send('ai:ask', request),
  aiCancel: (requestId?: string): void => ipcRenderer.send('ai:cancel', requestId),
  onAiToken: (callback: (event: AiTokenEvent) => void): (() => void) => {
    const listener = (_event: unknown, event: AiTokenEvent): void => callback(event)
    ipcRenderer.on('ai:token', listener)
    return () => ipcRenderer.removeListener('ai:token', listener)
  },
  onAiDone: (callback: (event: AiDoneEvent) => void): (() => void) => {
    const listener = (_event: unknown, event: AiDoneEvent): void => callback(event)
    ipcRenderer.on('ai:done', listener)
    return () => ipcRenderer.removeListener('ai:done', listener)
  },
  onAiError: (callback: (event: AiErrorEvent) => void): (() => void) => {
    const listener = (_event: unknown, event: AiErrorEvent): void => callback(event)
    ipcRenderer.on('ai:error', listener)
    return () => ipcRenderer.removeListener('ai:error', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (no context isolation fallback)
  window.api = api
}

export type Api = typeof api
