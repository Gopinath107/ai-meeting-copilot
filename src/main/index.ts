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
  dialog
} from 'electron'
import { join, extname, basename } from 'path'
import { readFile } from 'fs/promises'
import * as dotenv from 'dotenv'
import { DeepgramStream } from './deepgram'
import { SarvamStream, type AsrStream } from './sarvam'
import { streamChat, getAzureConfig, type ChatMessage } from './azure'
import { getSettings, getSettingsStatus, saveSettings, type AppSettings } from './settings'

dotenv.config()

let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let clickThrough = false
let stealthOn = true
let aiAbort: AbortController | null = null
const audioSamples = { system: 0, mic: 0 }
let audioStatsTimer: ReturnType<typeof setInterval> | null = null
const asrStreams: { system: AsrStream | null; mic: AsrStream | null } = {
  system: null,
  mic: null
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
  })

  overlayWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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

function applyStealth(value: boolean): void {
  stealthOn = value
  overlayWindow?.setContentProtection(value)
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

function startDeepgram(
  kind: 'system' | 'mic',
  source: 'interviewer' | 'you',
  apiKey: string
): void {
  asrStreams[kind]?.close()
  const stream = new DeepgramStream({
    apiKey,
    allowInsecureTls: getSettings().allowInsecureTls,
    onOpen: () => sendTranscriptStatus(source, 'connected', 'Deepgram'),
    onTranscript: (text, isFinal, speaker) =>
      overlayWindow?.webContents.send('transcript:update', { source, text, isFinal, speaker }),
    onError: (error) => {
      console.error(`Deepgram ${kind} error:`, error.message)
      sendTranscriptStatus(source, 'error', error.message)
    },
    onClose: () => sendTranscriptStatus(source, 'closed')
  })
  stream.connect()
  asrStreams[kind] = stream
}

/**
 * Sarvam AI is the primary speech-to-text provider. If it cannot connect (bad
 * key, network/TLS failure, service down) we transparently fall back to Deepgram
 * for that source so transcription keeps working.
 */
function startSarvam(
  kind: 'system' | 'mic',
  source: 'interviewer' | 'you',
  sarvamApiKey: string,
  deepgramApiKey: string
): void {
  asrStreams[kind]?.close()
  let opened = false
  let switched = false
  const fallback = (reason: string): void => {
    if (switched || opened) return // only fall back on initial-connection failure
    switched = true
    if (!deepgramApiKey) {
      sendTranscriptStatus(source, 'error', `Sarvam unavailable (${reason}); no Deepgram fallback`)
      return
    }
    console.warn(`Sarvam ${kind} failed (${reason}) — falling back to Deepgram`)
    sendTranscriptStatus(source, 'connecting', 'Sarvam unavailable — using Deepgram')
    startDeepgram(kind, source, deepgramApiKey)
  }
  const stream = new SarvamStream({
    apiKey: sarvamApiKey,
    allowInsecureTls: getSettings().allowInsecureTls,
    onOpen: () => {
      opened = true
      sendTranscriptStatus(source, 'connected', 'Sarvam')
    },
    onTranscript: (text, isFinal, speaker) =>
      overlayWindow?.webContents.send('transcript:update', { source, text, isFinal, speaker }),
    onError: (error) => {
      console.error(`Sarvam ${kind} error:`, error.message)
      if (opened) sendTranscriptStatus(source, 'error', error.message)
      else fallback(error.message)
    },
    onClose: () => {
      if (opened) sendTranscriptStatus(source, 'closed')
      else fallback('connection closed')
    }
  })
  stream.connect()
  asrStreams[kind] = stream
}

function startAsr(kind: 'system' | 'mic', source: 'interviewer' | 'you'): void {
  const s = getSettings()
  if (s.sarvamApiKey) {
    startSarvam(kind, source, s.sarvamApiKey, s.deepgramApiKey)
  } else if (s.deepgramApiKey) {
    startDeepgram(kind, source, s.deepgramApiKey)
  } else {
    sendTranscriptStatus(source, 'error', 'Speech service not configured')
  }
}

function stopAsr(): void {
  asrStreams.system?.close()
  asrStreams.mic?.close()
  asrStreams.system = null
  asrStreams.mic = null
}

/** Extract plain text from a résumé/doc file (pdf, docx, or plain text). */
async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase()
  const buf = await readFile(filePath)
  try {
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: new Uint8Array(buf) })
      try {
        return (await parser.getText()).text
      } finally {
        await parser.destroy()
      }
    }
    if (ext === '.docx') {
      const mammoth = await import('mammoth')
      return (await mammoth.extractRawText({ buffer: buf })).value
    }
  } catch (error) {
    console.error('Failed to parse', filePath, (error as Error).message)
    return ''
  }
  return buf.toString('utf-8')
}

function setupAudio(): void {
  // Grant system-audio loopback for getDisplayMedia (the interviewer's voice).
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch((error) => {
          console.error('desktopCapturer failed:', error)
          callback({})
        })
    },
    { useSystemPicker: false }
  )

  // Allow microphone access from the renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  // Receive 16 kHz PCM chunks from the renderer and forward them to Deepgram.
  ipcMain.on('audio:chunk', (_event, kind: 'system' | 'mic', buffer: ArrayBuffer) => {
    if (kind === 'system' || kind === 'mic') {
      audioSamples[kind] += buffer.byteLength / 2
      asrStreams[kind]?.send(buffer)
    }
  })
  ipcMain.on('audio:start', (_event, mic: boolean) => {
    audioSamples.system = 0
    audioSamples.mic = 0
    if (audioStatsTimer) clearInterval(audioStatsTimer)
    audioStatsTimer = setInterval(() => {
      overlayWindow?.webContents.send('audio:stats', {
        system: audioSamples.system / 16000,
        mic: audioSamples.mic / 16000
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
  ipcMain.on('audio:stop', () => {
    if (audioStatsTimer) {
      clearInterval(audioStatsTimer)
      audioStatsTimer = null
    }
    stopAsr()
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

app.whenReady().then(() => {
  createOverlayWindow()
  registerHotkeys()
  setupTray()

  ipcMain.handle('app:getVersion', () => app.getVersion())
  ipcMain.handle('app:hasKeys', () => {
    const s = getSettingsStatus()
    return {
      deepgram: s.sarvamKeySet || s.deepgramKeySet,
      azureOpenAI: s.azureKeySet && Boolean(s.azureEndpoint)
    }
  })

  ipcMain.handle('settings:get', () => getSettingsStatus())
  ipcMain.handle('settings:save', (_event, partial: Partial<AppSettings>) => {
    saveSettings(partial)
    return getSettingsStatus()
  })

  ipcMain.on('window:hide', () => overlayWindow?.hide())
  ipcMain.on('window:quit', () => app.quit())
  ipcMain.on('window:setClickThrough', (_event, value: boolean) => {
    clickThrough = value
    overlayWindow?.setIgnoreMouseEvents(value, { forward: true })
  })

  ipcMain.handle('window:getStealth', () => stealthOn)
  ipcMain.on('window:setStealth', (_event, value: boolean) => {
    applyStealth(value)
  })

  ipcMain.handle('ai:hasConfig', () => getAzureConfig() !== null)
  ipcMain.on('ai:ask', (_event, messages: ChatMessage[]) => {
    const config = getAzureConfig()
    if (!config) {
      overlayWindow?.webContents.send('ai:error', 'AI service not configured')
      return
    }
    aiAbort?.abort()
    aiAbort = new AbortController()
    void streamChat(
      config,
      messages,
      {
        onToken: (text) => overlayWindow?.webContents.send('ai:token', text),
        onDone: () => overlayWindow?.webContents.send('ai:done'),
        onError: (error) => overlayWindow?.webContents.send('ai:error', error.message)
      },
      aiAbort.signal
    )
  })
  ipcMain.on('ai:cancel', () => {
    aiAbort?.abort()
    aiAbort = null
  })

  ipcMain.handle('docs:pick', async (_event, kind: 'resume' | 'extra') => {
    const opts: Electron.OpenDialogOptions = {
      title: kind === 'resume' ? 'Select your résumé' : 'Select documents',
      properties: kind === 'extra' ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const result = overlayWindow
      ? await dialog.showOpenDialog(overlayWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const names: string[] = []
    const parts: string[] = []
    for (const filePath of result.filePaths) {
      names.push(basename(filePath))
      const text = (await extractText(filePath)).trim()
      if (text) parts.push(text)
    }
    const cap = kind === 'resume' ? 8000 : 5000
    return { names, text: parts.join('\n\n---\n\n').slice(0, cap) }
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
  tray?.destroy()
  tray = null
})
