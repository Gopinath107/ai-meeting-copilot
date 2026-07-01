import { contextBridge, ipcRenderer } from 'electron'

export type HotkeyPayload = { action: string; value?: unknown }
export type KeyStatus = { deepgram: boolean; azureOpenAI: boolean }
export type TranscriptSource = 'interviewer' | 'you'
export type TranscriptUpdate = {
  source: TranscriptSource
  text: string
  isFinal: boolean
  speaker?: number
}
export type TranscriptStatus = { source: TranscriptSource; status: string; message?: string }
export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type PickedDocs = { names: string[]; text: string }
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
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  hasKeys: (): Promise<KeyStatus> => ipcRenderer.invoke('app:hasKeys'),
  getSettings: (): Promise<SettingsStatus> => ipcRenderer.invoke('settings:get'),
  saveSettings: (input: SettingsInput): Promise<SettingsStatus> =>
    ipcRenderer.invoke('settings:save', input),
  pickDocument: (kind: 'resume' | 'extra'): Promise<PickedDocs | null> =>
    ipcRenderer.invoke('docs:pick', kind),
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
  audioStart: (mic: boolean): void => ipcRenderer.send('audio:start', mic),
  audioStop: (): void => ipcRenderer.send('audio:stop'),
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
  aiAsk: (messages: AiMessage[]): void => ipcRenderer.send('ai:ask', messages),
  aiCancel: (): void => ipcRenderer.send('ai:cancel'),
  onAiToken: (callback: (text: string) => void): (() => void) => {
    const listener = (_event: unknown, text: string): void => callback(text)
    ipcRenderer.on('ai:token', listener)
    return () => ipcRenderer.removeListener('ai:token', listener)
  },
  onAiDone: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('ai:done', listener)
    return () => ipcRenderer.removeListener('ai:done', listener)
  },
  onAiError: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: unknown, message: string): void => callback(message)
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
