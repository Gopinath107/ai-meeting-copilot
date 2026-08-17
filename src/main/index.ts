import {
  app,
  shell,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  session,
  desktopCapturer,
  nativeImage,
  Tray,
  Menu,
  dialog,
  clipboard
} from 'electron'
import { join, extname, basename } from 'path'
import { readFile, stat } from 'fs/promises'
import * as dotenv from 'dotenv'
import { DeepgramStream } from './deepgram'
import { SarvamStream, type AsrStream } from './sarvam'
import {
  AsrSessionManager,
  waitForFinalTranscriptSettle,
  type AsrKind,
  type AsrSessionSnapshot
} from './asrSession'
import { streamChat, getAzureConfig, type ChatMessage } from './azure'
import { getSettings, getSettingsStatus, saveSettings, type AppSettings } from './settings'
import { extractDocxTextInWorker } from './docxParser'
import type { AiAskRequest, AiTextMessage, ScreenshotContext } from '../shared/ai'
import type { AudioStopResult, DisplaySourceInfo, PickedDocs } from '../shared/capture'

dotenv.config()

let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let clickThrough = false
let stealthOn = true
// Guards reassertStealth() against re-entrancy (showInactive re-fires 'show').
let reassertingStealth = false
let aiAbort: AbortController | null = null
let activeAiRequestId: string | null = null
const audioSamples = { system: 0, mic: 0 }
let audioStatsTimer: ReturnType<typeof setInterval> | null = null
// Capture/transcription sample rate. Must be 16 kHz: Sarvam's streaming STT (the
// primary provider for the interviewer/system audio) only accepts 16 kHz PCM —
// sending 48 kHz makes it reject the stream or mis-decode the audio (garbled
// text). Deepgram works fine at 16 kHz too. Must match the renderer's
// AudioCapture rate.
const SAMPLE_RATE = 16000
type AsrProvider = 'auto' | 'deepgram' | 'sarvam'
let asrProvider: AsrProvider = 'auto'
// Domain terms (tech stack / product names) to bias Deepgram recognition toward
// so meeting jargon isn't misheard. Set per session from the renderer.
let asrKeyterms: string[] = []
const asrSessions = new AsrSessionManager<AsrStream>()
const finalTranscriptCounts = new Map<string, number>()
const finalTranscriptListeners = new Set<(kind: AsrKind, generation: number) => void>()
let selectedDisplaySource: { id: string; displayId: string } | null = null

const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md'])
const MAX_EXTRA_DOCUMENTS = 8
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_DOCUMENT_BYTES = 24 * 1024 * 1024
const MAX_PDF_PAGES = 100
const MAX_EXTRACTED_DOCUMENT_CHARS = 200_000
const DOCUMENT_PARSE_TIMEOUT_MS = 15_000

export function isSafeExternalUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 4096) return false
  try {
    const protocol = new URL(value).protocol.toLowerCase()
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

function createOverlayWindow(): void {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = 460
  const height = 660

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: workAreaSize.width - width - 24,
    y: 24,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // ===== STEALTH =====
  // Exclude the window from screen capture / screen sharing.
  // Windows -> WDA_EXCLUDEFROMCAPTURE, macOS -> NSWindowSharingNone.
  // The user sees the overlay; anyone viewing a shared screen / recording does not.
  // Default ON; toggleable live from the overlay UI (window:setStealth).
  overlayWindow.setContentProtection(stealthOn)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  overlayWindow.on('ready-to-show', () => {
    overlayWindow?.show()
    // Content protection must be (re)applied AFTER the native window exists and
    // is shown — setting it while show:false can fail to bind to the HWND, which
    // is why the overlay could still leak into a screen share. Re-assert here.
    reassertStealth()
  })

  // Windows can reset the capture-exclusion affinity when a window is re-shown
  // after hide(); re-assert stealth every time it becomes visible.
  overlayWindow.on('show', () => reassertStealth())

  overlayWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url).catch((error) => {
        console.warn('Failed to open external URL:', (error as Error).message)
      })
    } else {
      console.warn('Blocked unsafe external URL scheme')
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function toggleVisibility(): void {
  if (!overlayWindow) return
  if (overlayWindow.isVisible()) overlayWindow.hide()
  else overlayWindow.show()
}

function toggleClickThrough(): void {
  if (!overlayWindow) return
  clickThrough = !clickThrough
  overlayWindow.setIgnoreMouseEvents(clickThrough, { forward: true })
  overlayWindow.webContents.send('hotkey', { action: 'click-through', value: clickThrough })
}

/**
 * Re-apply the current stealth (capture-exclusion) state and keep the overlay
 * visible to the user. Toggling Windows content protection on a transparent,
 * always-on-top window can drop it out of the compositor, so after (re)applying
 * we re-assert always-on-top and force a repaint/re-show so it never vanishes
 * from the user's own screen.
 */
function reassertStealth(): void {
  const win = overlayWindow
  if (!win || win.isDestroyed()) return
  // showInactive() below re-fires the 'show' event, which calls this function
  // again — guard against that infinite recursion.
  if (reassertingStealth) return
  reassertingStealth = true
  try {
    win.setContentProtection(stealthOn)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (win.isVisible()) {
      // showInactive() re-composites the window without stealing focus, fixing
      // the "overlay disappears after toggling stealth" case.
      win.showInactive()
      win.webContents.invalidate()
    }
  } finally {
    reassertingStealth = false
  }
}

function applyStealth(value: boolean): void {
  stealthOn = value
  reassertStealth()
  overlayWindow?.webContents.send('stealth:changed', value)
  tray?.setToolTip(`Interview Copilot — ${value ? 'stealth ON (invisible)' : 'visible'}`)
}

function showOverlay(): void {
  if (!overlayWindow) {
    createOverlayWindow()
    return
  }
  overlayWindow.show()
  overlayWindow.focus()
}

function safeRegister(accelerator: string, handler: () => void): void {
  try {
    const ok = globalShortcut.register(accelerator, handler)
    if (!ok) console.warn(`Failed to register hotkey: ${accelerator}`)
  } catch (error) {
    console.warn(`Invalid hotkey ${accelerator}:`, error)
  }
}

function registerHotkeys(): void {
  // Toggle the overlay on/off instantly
  safeRegister('CommandOrControl+Shift+Space', toggleVisibility)
  // Panic hide
  safeRegister('CommandOrControl+Shift+H', () => overlayWindow?.hide())
  // Make the overlay click-through (mouse passes to the app behind it)
  safeRegister('CommandOrControl+Shift+\\', toggleClickThrough)
  // Ask the AI for an answer (wired to the LLM in a later phase)
  safeRegister('CommandOrControl+Shift+Enter', () => {
    overlayWindow?.webContents.send('hotkey', { action: 'ask' })
  })
}

function sendTranscriptStatus(
  source: 'interviewer' | 'you',
  status: string,
  message?: string
): void {
  overlayWindow?.webContents.send('transcript:status', { source, status, message })
}

function sendTranscript(
  kind: AsrKind,
  source: 'interviewer' | 'you',
  generation: number,
  stream: AsrStream,
  text: string,
  isFinal: boolean,
  speaker?: number,
  confidence?: number
): void {
  if (!asrSessions.isCurrent(kind, generation, stream)) return
  if (isFinal) {
    const key = `${kind}:${generation}`
    finalTranscriptCounts.set(key, (finalTranscriptCounts.get(key) ?? 0) + 1)
    for (const listener of finalTranscriptListeners) listener(kind, generation)
  }
  overlayWindow?.webContents.send('transcript:update', {
    source,
    text,
    isFinal,
    speaker,
    confidence
  })
}

function startDeepgram(
  kind: AsrKind,
  source: 'interviewer' | 'you',
  apiKey: string,
  generation: number
): void {
  const stream = new DeepgramStream({
    apiKey,
    sampleRate: SAMPLE_RATE,
    keyterms: asrKeyterms,
    allowInsecureTls: getSettings().allowInsecureTls,
    onOpen: () => {
      if (!asrSessions.isCurrent(kind, generation, stream)) return
      if (asrSessions.isIntentionalClose(kind, generation, stream)) {
        stream.flush()
      } else {
        sendTranscriptStatus(source, 'connected', 'Deepgram')
      }
    },
    onTranscript: (text, isFinal, speaker, confidence) =>
      sendTranscript(kind, source, generation, stream, text, isFinal, speaker, confidence),
    onError: (error) => {
      if (!asrSessions.isCurrent(kind, generation, stream)) return
      console.error(`Deepgram ${kind} error:`, error.message)
      if (!asrSessions.isIntentionalClose(kind, generation, stream)) {
        sendTranscriptStatus(source, 'error', error.message)
      }
    },
    onClose: () => {
      if (!asrSessions.isCurrent(kind, generation, stream)) return
      const intentional = asrSessions.isIntentionalClose(kind, generation, stream)
      asrSessions.clearIfCurrent(kind, generation, stream)
      if (!intentional) sendTranscriptStatus(source, 'closed')
    }
  })
  if (!asrSessions.install(kind, generation, stream)) return
  try {
    stream.connect()
  } catch (error) {
    asrSessions.clearIfCurrent(kind, generation, stream)
    stream.close()
    sendTranscriptStatus(source, 'error', (error as Error).message)
  }
}

/**
 * Sarvam AI is the primary speech-to-text provider. If it cannot connect (bad
 * key, network/TLS failure, service down) we transparently fall back to Deepgram
 * for that source so transcription keeps working.
 */
function startSarvam(
  kind: AsrKind,
  source: 'interviewer' | 'you',
  sarvamApiKey: string,
  deepgramApiKey: string,
  generation: number,
  codeMixed = false
): void {
  let opened = false
  let switched = false
  const fallback = (reason: string): void => {
    if (switched || opened || !asrSessions.canFallback(kind, generation, stream)) return
    switched = true
    if (!deepgramApiKey) {
      asrSessions.clearIfCurrent(kind, generation, stream)
      sendTranscriptStatus(source, 'error', `Sarvam unavailable (${reason}); no Deepgram fallback`)
      return
    }
    console.warn(`Sarvam ${kind} failed (${reason}) — falling back to Deepgram`)
    sendTranscriptStatus(source, 'connecting', 'Sarvam unavailable — using Deepgram')
    startDeepgram(kind, source, deepgramApiKey, generation)
  }
  const stream = new SarvamStream({
    apiKey: sarvamApiKey,
    sampleRate: SAMPLE_RATE,
    // Code-mixed meetings (Indian languages + English in one sentence): let
    // Sarvam auto-detect and transcribe the mixed speech instead of forcing
    // English-only. Interview mode stays 'en-IN' (English, Indian accent).
    language: codeMixed ? 'unknown' : 'en-IN',
    onOpen: () => {
      if (!asrSessions.isCurrent(kind, generation, stream)) return
      opened = true
      if (asrSessions.isIntentionalClose(kind, generation, stream)) {
        stream.flush()
      } else {
        sendTranscriptStatus(source, 'connected', 'Sarvam')
      }
    },
    onTranscript: (text, isFinal, speaker, confidence) =>
      sendTranscript(kind, source, generation, stream, text, isFinal, speaker, confidence),
    onError: (error) => {
      if (!asrSessions.isCurrent(kind, generation, stream)) return
      console.error(`Sarvam ${kind} error:`, error.message)
      if (asrSessions.isIntentionalClose(kind, generation, stream)) return
      if (opened) sendTranscriptStatus(source, 'error', error.message)
      else fallback(error.message)
    },
    onClose: () => {
      if (!asrSessions.isCurrent(kind, generation, stream)) return
      if (asrSessions.isIntentionalClose(kind, generation, stream)) {
        asrSessions.clearIfCurrent(kind, generation, stream)
      } else if (opened) {
        asrSessions.clearIfCurrent(kind, generation, stream)
        sendTranscriptStatus(source, 'closed')
      } else {
        fallback('connection closed')
      }
    }
  })
  if (!asrSessions.install(kind, generation, stream)) return
  try {
    stream.connect()
  } catch (error) {
    fallback((error as Error).message)
  }
}

function startAsr(kind: AsrKind, source: 'interviewer' | 'you'): void {
  const generation = asrSessions.begin(kind)
  const s = getSettings()
  // Force Deepgram when the user wants per-speaker labels (diarization). Good
  // for English meetings where telling participants apart matters.
  if (asrProvider === 'deepgram') {
    if (s.deepgramApiKey) {
      startDeepgram(kind, source, s.deepgramApiKey, generation)
    } else {
      sendTranscriptStatus(source, 'error', 'Deepgram key not set (needed for speaker labels)')
    }
    return
  }
  // Force Sarvam for best accuracy on Indian-accented English (no labels). Use
  // en-IN, not auto-detect: fixing the language to English is markedly more
  // accurate than 'unknown', which can flip to Hindi/other-language phonetics
  // and garble English words.
  if (asrProvider === 'sarvam') {
    if (s.sarvamApiKey) {
      startSarvam(kind, source, s.sarvamApiKey, s.deepgramApiKey, generation, false)
    } else if (s.deepgramApiKey) {
      startDeepgram(kind, source, s.deepgramApiKey, generation)
    } else {
      sendTranscriptStatus(source, 'error', 'Speech service not configured')
    }
    return
  }
  // 'auto': Sarvam primary (English en-IN for accuracy), Deepgram fallback.
  if (s.sarvamApiKey) {
    startSarvam(kind, source, s.sarvamApiKey, s.deepgramApiKey, generation, false)
  } else if (s.deepgramApiKey) {
    startDeepgram(kind, source, s.deepgramApiKey, generation)
  } else {
    sendTranscriptStatus(source, 'error', 'Speech service not configured')
  }
}

function stopAsr(): void {
  asrSessions.stopAll()
}

async function gracefullyStopAsr(timeoutMs: number): Promise<AudioStopResult> {
  const snapshots = (['system', 'mic'] as const)
    .map((kind) => asrSessions.beginIntentionalClose(kind))
    .filter((snapshot): snapshot is AsrSessionSnapshot<AsrStream> => snapshot !== null)
  const startedAt = Date.now()
  if (snapshots.length === 0) {
    return { timedOut: false, waitedMs: 0, finalizedKinds: [] }
  }

  const sessionKeys = new Set(
    snapshots.map((snapshot) => `${snapshot.kind}:${snapshot.generation}`)
  )
  const countFor = (snapshot: AsrSessionSnapshot<AsrStream>): number =>
    finalTranscriptCounts.get(`${snapshot.kind}:${snapshot.generation}`) ?? 0
  const initialCounts = new Map(
    snapshots.map((snapshot) => [`${snapshot.kind}:${snapshot.generation}`, countFor(snapshot)])
  )
  const waits = snapshots.map((snapshot) =>
    waitForFinalTranscriptSettle(
      () => countFor(snapshot),
      (listener) => {
        const scopedListener = (kind: AsrKind, generation: number): void => {
          if (kind === snapshot.kind && generation === snapshot.generation) listener()
        }
        finalTranscriptListeners.add(scopedListener)
        return () => finalTranscriptListeners.delete(scopedListener)
      },
      timeoutMs
    )
  )

  for (const snapshot of snapshots) snapshot.stream.flush()
  const settled = await Promise.all(waits)
  for (const snapshot of snapshots) asrSessions.closeSnapshot(snapshot)

  const result: AudioStopResult = {
    timedOut: settled.some((entry) => entry.timedOut),
    waitedMs: Date.now() - startedAt,
    finalizedKinds: snapshots
      .filter(
        (snapshot) =>
          countFor(snapshot) >
          (initialCounts.get(`${snapshot.kind}:${snapshot.generation}`) ?? 0)
      )
      .map((snapshot) => snapshot.kind)
  }
  for (const key of sessionKeys) finalTranscriptCounts.delete(key)
  return result
}

/** Extract plain text from a résumé/doc file (pdf, docx, or plain text). */
export function isSupportedDocumentPath(filePath: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  if (!DOCUMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported document type: ${ext || 'no extension'}`)
  }
  const metadata = await stat(filePath)
  if (!metadata.isFile()) throw new Error('The selected path is not a file')
  if (metadata.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`File is larger than the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit`)
  }
  const buf = await readFile(filePath)
  if (buf.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`File grew beyond the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB limit`)
  }
  try {
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({
        data: new Uint8Array(buf),
        stopAtErrors: true,
        isEvalSupported: false,
        enableXfa: false,
        disableFontFace: true,
        maxImageSize: 10_000_000
      })
      try {
        return await withTimeout(
          (async () => {
            const info = await parser.getInfo()
            if (info.total > MAX_PDF_PAGES) {
              throw new Error(`PDF has ${info.total} pages; the limit is ${MAX_PDF_PAGES}`)
            }
            const text = (await parser.getText({ first: MAX_PDF_PAGES })).text
            return text.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)
          })(),
          DOCUMENT_PARSE_TIMEOUT_MS,
          'PDF parsing'
        )
      } finally {
        await withTimeout(parser.destroy(), 2_000, 'PDF cleanup').catch(() => undefined)
      }
    }
    if (ext === '.docx') {
      return await extractDocxTextInWorker(buf, {
        timeoutMs: DOCUMENT_PARSE_TIMEOUT_MS,
        maxCharacters: MAX_EXTRACTED_DOCUMENT_CHARS
      })
    }
  } catch (error) {
    console.error('Failed to parse', filePath, (error as Error).message)
    throw new Error(`Could not parse ${basename(filePath)}: ${(error as Error).message}`, {
      cause: error
    })
  }
  return buf.toString('utf-8').slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)
}

type ValidatedDocument = { filePath: string; name: string; size: number }

async function validateDocumentSelection(
  filePaths: string[],
  kind: 'resume' | 'extra'
): Promise<{ documents: ValidatedDocument[]; warnings: string[] }> {
  const warnings: string[] = []
  const maxCount = kind === 'resume' ? 1 : MAX_EXTRA_DOCUMENTS
  const candidates = filePaths.slice(0, maxCount)
  if (filePaths.length > maxCount) {
    warnings.push(
      `${filePaths.length - maxCount} file(s) were skipped; you can select at most ${maxCount}.`
    )
  }

  const documents: ValidatedDocument[] = []
  let totalBytes = 0
  for (const filePath of candidates) {
    const name = basename(filePath)
    if (!isSupportedDocumentPath(filePath)) {
      warnings.push(`${name} was skipped. Supported types: PDF, DOCX, TXT, and Markdown.`)
      continue
    }
    try {
      const metadata = await stat(filePath)
      if (!metadata.isFile()) {
        warnings.push(`${name} was skipped because it is not a regular file.`)
        continue
      }
      if (metadata.size > MAX_DOCUMENT_BYTES) {
        warnings.push(
          `${name} was skipped because it exceeds the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB per-file limit.`
        )
        continue
      }
      if (totalBytes + metadata.size > MAX_TOTAL_DOCUMENT_BYTES) {
        warnings.push(
          `${name} was skipped because the selection exceeds the ${MAX_TOTAL_DOCUMENT_BYTES / 1024 / 1024} MB total limit.`
        )
        continue
      }
      totalBytes += metadata.size
      documents.push({ filePath, name, size: metadata.size })
    } catch (error) {
      warnings.push(`${name} could not be inspected: ${(error as Error).message}`)
    }
  }
  return { documents, warnings }
}

function isOverlaySender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(
    overlayWindow &&
      !overlayWindow.isDestroyed() &&
      !overlayWindow.webContents.isDestroyed() &&
      event.sender === overlayWindow.webContents
  )
}

function assertOverlaySender(event: Electron.IpcMainInvokeEvent): void {
  if (!isOverlaySender(event)) throw new Error('Unauthorized IPC sender')
}

function parseSettingsInput(value: unknown): Partial<AppSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid settings payload')
  }
  const input = value as Record<string, unknown>
  type StringSetting = Exclude<keyof AppSettings, 'allowInsecureTls'>
  const limits: Record<StringSetting, number> = {
    sarvamApiKey: 16 * 1024,
    deepgramApiKey: 16 * 1024,
    azureApiKey: 16 * 1024,
    azureEndpoint: 2 * 1024,
    azureDeployment: 512,
    azureApiVersion: 128
  }
  const strings: Partial<Record<StringSetting, string>> = {}
  for (const key of Object.keys(limits) as StringSetting[]) {
    const candidate = input[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string' || candidate.length > limits[key]) {
      throw new Error(`Invalid ${key} setting`)
    }
    strings[key] = candidate
  }
  const insecure = input.allowInsecureTls
  if (insecure !== undefined && typeof insecure !== 'boolean') {
    throw new Error('Invalid allowInsecureTls setting')
  }
  return {
    ...strings,
    ...(typeof insecure === 'boolean' ? { allowInsecureTls: insecure } : {})
  }
}

async function getDisplaySources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
}

function primaryDisplaySource(
  sources: Electron.DesktopCapturerSource[]
): Electron.DesktopCapturerSource | undefined {
  const primaryDisplayId = String(screen.getPrimaryDisplay().id)
  return sources.find((source) => source.display_id === primaryDisplayId) ?? sources[0]
}

function resolveSelectedDisplaySource(
  sources: Electron.DesktopCapturerSource[]
): Electron.DesktopCapturerSource | undefined {
  const preference = selectedDisplaySource
  const selected = preference
    ? sources.find(
        (source) =>
          source.id === preference.id ||
          (preference.displayId.length > 0 && source.display_id === preference.displayId)
      )
    : undefined
  const resolved = selected ?? primaryDisplaySource(sources)
  if (resolved && !selected) {
    selectedDisplaySource = { id: resolved.id, displayId: resolved.display_id }
  }
  return resolved
}

function serializeDisplaySource(
  source: Electron.DesktopCapturerSource,
  selected: Electron.DesktopCapturerSource | undefined
): DisplaySourceInfo {
  return {
    id: source.id,
    name: source.name,
    displayId: source.display_id,
    isPrimary: source.display_id === String(screen.getPrimaryDisplay().id),
    isSelected: source.id === selected?.id
  }
}

async function listDisplaySources(): Promise<DisplaySourceInfo[]> {
  const sources = await getDisplaySources()
  const selected = resolveSelectedDisplaySource(sources)
  return sources.map((source) => serializeDisplaySource(source, selected))
}

function setupAudio(): void {
  // Grant system-audio loopback for getDisplayMedia (the interviewer's voice).
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!overlayWindow || request.frame !== overlayWindow.webContents.mainFrame) {
        callback({})
        return
      }
      getDisplaySources()
        .then((sources) => {
          const source = resolveSelectedDisplaySource(sources)
          if (!source) {
            console.error('No display source is available for system-audio capture')
            callback({})
            return
          }
          callback({ video: source, audio: request.audioRequested ? 'loopback' : undefined })
        })
        .catch((error) => {
          console.error('desktopCapturer failed:', error)
          callback({})
        })
    },
    { useSystemPicker: false }
  )

  // Allow microphone and display capture only from the trusted overlay renderer.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(
      (permission === 'media' || permission === 'display-capture') &&
        webContents === overlayWindow?.webContents
    )
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    // Electron's PermissionCheckHandler type lags the runtime permission list in
    // some releases, but Chromium can still query `display-capture` here.
    const requestedPermission: string = permission
    return (
      (requestedPermission === 'media' || requestedPermission === 'display-capture') &&
      webContents === overlayWindow?.webContents
    )
  })

  // Receive 16 kHz PCM chunks from the renderer and forward them to Deepgram.
  ipcMain.on('audio:chunk', (event, kind: unknown, buffer: unknown) => {
    if (
      isOverlaySender(event) &&
      (kind === 'system' || kind === 'mic') &&
      buffer instanceof ArrayBuffer &&
      buffer.byteLength > 0 &&
      buffer.byteLength <= 64 * 1024 &&
      buffer.byteLength % 2 === 0
    ) {
      audioSamples[kind] += buffer.byteLength / 2
      asrSessions.current(kind)?.send(buffer)
    }
  })
  ipcMain.on('audio:start', (event, mic: unknown, provider?: unknown, keyterms?: unknown) => {
    if (!isOverlaySender(event) || typeof mic !== 'boolean') return
    stopAsr()
    asrProvider = provider === 'deepgram' || provider === 'sarvam' ? provider : 'auto'
    asrKeyterms = Array.isArray(keyterms)
      ? keyterms
          .filter((term): term is string => typeof term === 'string')
          .map((term) => term.trim().slice(0, 100))
          .filter(Boolean)
          .slice(0, 100)
      : []
    audioSamples.system = 0
    audioSamples.mic = 0
    if (audioStatsTimer) clearInterval(audioStatsTimer)
    audioStatsTimer = setInterval(() => {
      overlayWindow?.webContents.send('audio:stats', {
        system: audioSamples.system / SAMPLE_RATE,
        mic: audioSamples.mic / SAMPLE_RATE
      })
    }, 1000)

    // Open a live-transcription stream per active source. Sarvam is primary and
    // Deepgram is the automatic fallback (handled inside startAsr).
    const s = getSettings()
    if (!s.sarvamApiKey && !s.deepgramApiKey) {
      overlayWindow?.webContents.send('transcript:status', {
        source: 'interviewer',
        status: 'error',
        message: 'Speech service not configured'
      })
      return
    }
    startAsr('system', 'interviewer')
    if (mic) startAsr('mic', 'you')
  })
  ipcMain.on('audio:setMic', (event, enabled: unknown) => {
    if (!isOverlaySender(event) || typeof enabled !== 'boolean') return
    if (enabled) {
      if (!asrSessions.current('mic')) {
        audioSamples.mic = 0
        startAsr('mic', 'you')
      }
    } else {
      asrSessions.stop('mic')
      sendTranscriptStatus('you', 'closed', 'Microphone disabled')
    }
  })
  ipcMain.on('audio:stop', (event) => {
    if (!isOverlaySender(event)) return
    if (audioStatsTimer) {
      clearInterval(audioStatsTimer)
      audioStatsTimer = null
    }
    stopAsr()
  })
  ipcMain.handle('audio:stopGracefully', async (event, requestedTimeout?: unknown) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized audio stop request')
    if (audioStatsTimer) {
      clearInterval(audioStatsTimer)
      audioStatsTimer = null
    }
    const timeoutMs =
      typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
        ? Math.max(300, Math.min(5000, Math.round(requestedTimeout)))
        : 1800
    return gracefullyStopAsr(timeoutMs)
  })
}

function createTrayIcon(): Electron.NativeImage {
  // Generate a small round dot icon in code so no asset file is required.
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size / 2 - 1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = Math.hypot(x - center, y - center) <= radius
      buffer[i] = 241 // B
      buffer[i + 1] = 102 // G
      buffer[i + 2] = 99 // R
      buffer[i + 3] = inside ? 255 : 0 // A
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size })
}

function setupTray(): void {
  try {
    tray = new Tray(createTrayIcon())
    tray.setToolTip('Interview Copilot — stealth ON (invisible)')
    const menu = Menu.buildFromTemplate([
      { label: 'Show overlay', click: () => showOverlay() },
      { label: 'Hide overlay', click: () => overlayWindow?.hide() },
      { label: 'Toggle stealth', click: () => applyStealth(!stealthOn) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
    tray.setContextMenu(menu)
    tray.on('click', () => showOverlay())
  } catch (error) {
    console.warn('Tray unavailable:', error)
  }
}

function validScreenshot(value: unknown): value is ScreenshotContext {
  if (!value || typeof value !== 'object') return false
  const shot = value as Partial<ScreenshotContext>
  if (typeof shot.dataUrl !== 'string' || shot.dataUrl.length > 6_000_000) return false
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(shot.dataUrl)) return false
  if (!Number.isFinite(shot.capturedAt) || !Number.isInteger(shot.width) || !Number.isInteger(shot.height)) {
    return false
  }
  if (Math.abs(Date.now() - (shot.capturedAt ?? 0)) > 30_000) return false
  if ((shot.width ?? 0) <= 0 || (shot.width ?? 0) > 4096) return false
  if ((shot.height ?? 0) <= 0 || (shot.height ?? 0) > 4096) return false
  return shot.detail === 'low' || shot.detail === 'auto' || shot.detail === 'high'
}

function validTextMessages(value: unknown): value is AiTextMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return false
  let total = 0
  for (const message of value) {
    if (!message || typeof message !== 'object') return false
    const m = message as Partial<AiTextMessage>
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') return false
    if (typeof m.content !== 'string') return false
    total += m.content.length
    if (m.content.length > 500_000 || total > 1_000_000) return false
  }
  return value[value.length - 1]?.role === 'user'
}

function parseAiRequest(value: unknown): AiAskRequest | null {
  if (!value || typeof value !== 'object') return null
  const request = value as Partial<AiAskRequest>
  if (
    typeof request.requestId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,100}$/.test(request.requestId)
  ) {
    return null
  }
  if (
    request.intent !== 'answer' &&
    request.intent !== 'analyze' &&
    request.intent !== 'summarize' &&
    request.intent !== 'minutes'
  ) {
    return null
  }
  if (!validTextMessages(request.messages)) return null
  if (request.screenshot !== undefined) {
    if (request.intent !== 'answer' && request.intent !== 'analyze') return null
    if (!validScreenshot(request.screenshot)) return null
  }
  return request as AiAskRequest
}

function azureMessages(request: AiAskRequest): ChatMessage[] {
  if (!request.screenshot) return request.messages
  const last = request.messages[request.messages.length - 1]
  return [
    ...request.messages.slice(0, -1),
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `${last.content}\n\nA current screenshot is attached. Use it with the transcript to understand what is being shown. ` +
            'Only rely on text and details that are visibly legible.'
        },
        {
          type: 'image_url',
          image_url: { url: request.screenshot.dataUrl, detail: request.screenshot.detail }
        }
      ]
    }
  ]
}

app.whenReady().then(() => {
  createOverlayWindow()
  registerHotkeys()
  setupTray()

  ipcMain.handle('app:getVersion', (event) => {
    assertOverlaySender(event)
    return app.getVersion()
  })
  ipcMain.handle('app:hasKeys', (event) => {
    assertOverlaySender(event)
    const s = getSettingsStatus()
    return {
      deepgram: s.sarvamKeySet || s.deepgramKeySet,
      azureOpenAI: s.azureKeySet && Boolean(s.azureEndpoint)
    }
  })

  ipcMain.handle('settings:get', (event) => {
    assertOverlaySender(event)
    return getSettingsStatus()
  })
  ipcMain.handle('settings:save', (event, partial: unknown) => {
    assertOverlaySender(event)
    saveSettings(parseSettingsInput(partial))
    return getSettingsStatus()
  })

  ipcMain.on('window:hide', (event) => {
    if (isOverlaySender(event)) overlayWindow?.hide()
  })
  ipcMain.on('window:quit', (event) => {
    if (isOverlaySender(event)) app.quit()
  })
  ipcMain.on('window:setClickThrough', (event, value: unknown) => {
    if (!isOverlaySender(event) || typeof value !== 'boolean') return
    clickThrough = value
    overlayWindow?.setIgnoreMouseEvents(value, { forward: true })
  })

  ipcMain.handle('window:getStealth', (event) => {
    assertOverlaySender(event)
    return stealthOn
  })
  ipcMain.on('window:setStealth', (event, value: unknown) => {
    if (!isOverlaySender(event) || typeof value !== 'boolean') return
    applyStealth(value)
  })

  ipcMain.handle('ai:hasConfig', (event) => {
    assertOverlaySender(event)
    return getAzureConfig() !== null
  })
  ipcMain.on('ai:ask', (event, payload: unknown) => {
    if (!overlayWindow || event.sender !== overlayWindow.webContents) return
    const request = parseAiRequest(payload)
    if (!request) {
      const candidateId = (payload as { requestId?: unknown } | null)?.requestId
      const requestId =
        typeof candidateId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(candidateId)
          ? candidateId
          : 'invalid-request'
      event.sender.send('ai:error', {
        requestId,
        message: 'Invalid AI request payload'
      })
      return
    }
    const config = getAzureConfig()
    if (!config) {
      overlayWindow.webContents.send('ai:error', {
        requestId: request.requestId,
        message: 'AI service not configured'
      })
      return
    }
    aiAbort?.abort()
    const controller = new AbortController()
    aiAbort = controller
    activeAiRequestId = request.requestId
    void streamChat(
      config,
      azureMessages(request),
      {
        onToken: (text) => {
          if (activeAiRequestId === request.requestId) {
            overlayWindow?.webContents.send('ai:token', { requestId: request.requestId, text })
          }
        },
        onDone: () => {
          if (activeAiRequestId !== request.requestId) return
          overlayWindow?.webContents.send('ai:done', { requestId: request.requestId })
          activeAiRequestId = null
          if (aiAbort === controller) aiAbort = null
        },
        onError: (error) => {
          if (activeAiRequestId !== request.requestId) return
          overlayWindow?.webContents.send('ai:error', {
            requestId: request.requestId,
            message: error.message
          })
          activeAiRequestId = null
          if (aiAbort === controller) aiAbort = null
        }
      },
      controller.signal
    )
  })
  ipcMain.on('ai:cancel', (event, requestId?: string) => {
    if (!overlayWindow || event.sender !== overlayWindow.webContents) return
    if (requestId && activeAiRequestId !== requestId) return
    activeAiRequestId = null
    aiAbort?.abort()
    aiAbort = null
  })

  ipcMain.handle('display:listSources', async (event) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized display-source request')
    return listDisplaySources()
  })
  ipcMain.handle('display:selectSource', async (event, sourceId: unknown) => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized display-source request')
    if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 256) {
      throw new Error('Invalid display source identifier')
    }
    const sources = await getDisplaySources()
    const source = sources.find((candidate) => candidate.id === sourceId)
    if (!source) {
      throw new Error('That display is no longer available. Refresh the display list and try again.')
    }
    selectedDisplaySource = { id: source.id, displayId: source.display_id }
    return serializeDisplaySource(source, source)
  })

  ipcMain.handle('docs:pick', async (event, requestedKind: unknown): Promise<PickedDocs | null> => {
    if (!isOverlaySender(event)) throw new Error('Unauthorized document request')
    if (requestedKind !== 'resume' && requestedKind !== 'extra') {
      throw new Error('Document selection must be either resume or extra documents')
    }
    const kind = requestedKind
    const opts: Electron.OpenDialogOptions = {
      title: kind === 'resume' ? 'Select your résumé' : 'Select documents',
      properties: kind === 'extra' ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] }]
    }
    const result = overlayWindow
      ? await dialog.showOpenDialog(overlayWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const validated = await validateDocumentSelection(result.filePaths, kind)
    const names: string[] = []
    const parts: string[] = []
    for (const document of validated.documents) {
      try {
        const text = (await extractText(document.filePath)).trim()
        names.push(document.name)
        if (text) parts.push(text)
        else validated.warnings.push(`${document.name} contained no readable text.`)
      } catch (error) {
        validated.warnings.push((error as Error).message)
      }
    }
    const cap = kind === 'resume' ? 8000 : 5000
    const combined = parts.join('\n\n---\n\n')
    if (combined.length > cap) {
      validated.warnings.push(`Extracted text was shortened to ${cap.toLocaleString()} characters.`)
    }
    return { names, text: combined.slice(0, cap), warnings: validated.warnings }
  })

  // Reliable copy-to-clipboard from the renderer. The web Clipboard API can fail
  // silently in a transparent, always-on-top, often-unfocused overlay window, so
  // we write through Electron's main-process clipboard instead.
  ipcMain.handle('clipboard:write', (event, text: unknown) => {
    assertOverlaySender(event)
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return false
    try {
      clipboard.writeText(text)
      return true
    } catch (error) {
      console.error('clipboard write failed:', error)
      return false
    }
  })

  setupAudio()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (audioStatsTimer) clearInterval(audioStatsTimer)
  stopAsr()
  aiAbort?.abort()
  activeAiRequestId = null
  tray?.destroy()
  tray = null
})
