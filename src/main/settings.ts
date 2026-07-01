import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'

/** Full effective configuration (secrets included). Lives in the MAIN process only. */
export interface AppSettings {
  sarvamApiKey: string
  deepgramApiKey: string
  azureEndpoint: string
  azureApiKey: string
  azureDeployment: string
  azureApiVersion: string
  allowInsecureTls: boolean
}

/** Non-secret view safe to hand to the renderer — never exposes the raw key strings. */
export interface SettingsStatus {
  sarvamKeySet: boolean
  deepgramKeySet: boolean
  azureKeySet: boolean
  azureEndpoint: string
  azureDeployment: string
  azureApiVersion: string
  allowInsecureTls: boolean
}

const DEFAULT_API_VERSION = '2024-12-01-preview'

let cache: Partial<AppSettings> | null = null

function settingsFile(): string {
  // Stored in the per-user app data dir so it survives updates and works in a packaged app
  // (where the bundled .env is not editable).
  return join(app.getPath('userData'), 'settings.json')
}

function load(): Partial<AppSettings> {
  if (cache) return cache
  try {
    cache = existsSync(settingsFile())
      ? (JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Partial<AppSettings>)
      : {}
  } catch (error) {
    console.warn('Failed to read settings, using defaults:', (error as Error).message)
    cache = {}
  }
  return cache
}

/** Effective config: stored values win, falling back to .env (dev convenience). */
export function getSettings(): AppSettings {
  const s = load()
  return {
    sarvamApiKey: s.sarvamApiKey || process.env.SARVAM_API_KEY || '',
    deepgramApiKey: s.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '',
    azureEndpoint: s.azureEndpoint || process.env.AZURE_OPENAI_ENDPOINT || '',
    azureApiKey: s.azureApiKey || process.env.AZURE_OPENAI_API_KEY || '',
    azureDeployment: s.azureDeployment || process.env.AZURE_OPENAI_DEPLOYMENT || '',
    azureApiVersion:
      s.azureApiVersion || process.env.AZURE_OPENAI_API_VERSION || DEFAULT_API_VERSION,
    allowInsecureTls: s.allowInsecureTls ?? process.env.DEEPGRAM_ALLOW_INSECURE_TLS === 'true'
  }
}

/** Renderer-facing status: booleans for secrets, plain values for non-secret config. */
export function getSettingsStatus(): SettingsStatus {
  const s = getSettings()
  return {
    sarvamKeySet: Boolean(s.sarvamApiKey),
    deepgramKeySet: Boolean(s.deepgramApiKey),
    azureKeySet: Boolean(s.azureApiKey),
    azureEndpoint: s.azureEndpoint,
    azureDeployment: s.azureDeployment,
    azureApiVersion: s.azureApiVersion,
    allowInsecureTls: s.allowInsecureTls
  }
}

/**
 * Persist a partial update. Blank API keys are ignored so the user can edit other
 * fields without clearing a previously-saved key by submitting an empty box.
 */
export function saveSettings(partial: Partial<AppSettings>): void {
  const next: Partial<AppSettings> = { ...load() }
  if (partial.sarvamApiKey) next.sarvamApiKey = partial.sarvamApiKey
  if (partial.deepgramApiKey) next.deepgramApiKey = partial.deepgramApiKey
  if (partial.azureApiKey) next.azureApiKey = partial.azureApiKey
  if (partial.azureEndpoint !== undefined) next.azureEndpoint = partial.azureEndpoint
  if (partial.azureDeployment !== undefined) next.azureDeployment = partial.azureDeployment
  if (partial.azureApiVersion !== undefined) next.azureApiVersion = partial.azureApiVersion
  if (partial.allowInsecureTls !== undefined) next.allowInsecureTls = partial.allowInsecureTls
  cache = next
  try {
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (error) {
    console.error('Failed to write settings:', (error as Error).message)
  }
}
