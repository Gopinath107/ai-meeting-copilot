# Interview Copilot

A stealth, real-time interview copilot for Windows. It listens to your meeting audio,
transcribes it live (Deepgram), and streams AI answer suggestions (Azure OpenAI) into a
floating overlay that is **hidden from screen sharing / recording**.

- **Stealth overlay** — excluded from screen capture (Zoom / Teams / Meet / OBS / Game Bar).
  You see it; people viewing your shared screen do not.
- **Live transcription** with multi-interviewer diarization ("Interviewer 1/2/3").
- **Streaming AI answers** grounded in your résumé + job description.
- **Manual question box** for scenario / long questions.
- 100% Node.js / TypeScript — no Python required.

> Honest limit: stealth defeats *software* capture only. It does **not** defeat a phone or a
> second camera physically pointed at your screen.

---

## 1. Prerequisites

- **Windows 10/11 (x64)**
- **Node.js 20+** (Node 22 LTS recommended — required for the `--use-system-ca` flag below)
- **npm** (ships with Node)
- API keys:
  - **Deepgram** API key (speech-to-text)
  - **Azure OpenAI** resource: endpoint, API key, and a chat deployment (e.g. `gpt-4o`)

---

## 2. Install

```powershell
npm install
```

### Behind a corporate TLS-inspection proxy

If `npm install` (or the Electron binary download) fails with
`unable to get local issuer certificate`, trust the Windows certificate store for the install:

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
npm install
```

If the PowerShell prompt blocks npm with an execution-policy error, allow scripts for the
current session first:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

---

## 3. Configure API keys

You can supply keys **either** way (the in-app Settings win over `.env`):

### Option A — In-app Settings (recommended; required for the packaged app)

1. Launch the app (see below).
2. Click **Settings** (top-right of the Setup screen).
3. Paste your Deepgram + Azure keys and the Azure endpoint / deployment / API version.
4. **Save.**

Keys are stored locally in your user app-data folder
(`%APPDATA%\interview-copilot\settings.json`) and are never shown back in the UI.

### Option B — `.env` file (handy for development)

```powershell
Copy-Item .env.example .env
```

Then edit `.env`:

```ini
DEEPGRAM_API_KEY=your_deepgram_key

AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your_azure_key
AZURE_OPENAI_DEPLOYMENT=rudhra-gpt-5.4-mini
AZURE_OPENAI_API_VERSION=2024-12-01-preview

# Only if your corporate proxy breaks the Deepgram TLS handshake (insecure — see notes):
DEEPGRAM_ALLOW_INSECURE_TLS=true
```

> `.env` is git-ignored and is **excluded from the packaged installer**, so it is only used in
> development. In a packaged build, use Settings (Option A).

---

## 4. Run (development)

```powershell
npm run dev
```

Behind a corporate proxy / restricted PowerShell, use the full incantation:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; $env:NODE_OPTIONS = ''; npm run dev
```

> Important: clear `NODE_OPTIONS` before `npm run dev`. Electron refuses to start if
> `--use-system-ca` is left in `NODE_OPTIONS`.

The overlay opens on the **Setup** screen. Fill in role / job description, optionally pick a
résumé (PDF / DOCX / TXT), then **Start session**.

---

## 5. Use it

1. Join your interview through your **own** meeting link as normal (do not bot-join).
2. In the overlay, click **Start listening** (and toggle **Mic** if you want your own voice
   transcribed too).
3. AI answers stream automatically when an interviewer asks a question, or trigger them
   manually with the hotkey / **Answer** button, or type a question in the manual box.

### Hotkeys

| Hotkey | Action |
| --- | --- |
| `Ctrl+Shift+Space` | Show / hide (and reopen) the overlay |
| `Ctrl+Shift+H` | Panic hide |
| `Ctrl+Shift+Enter` | Ask the AI now |
| `Ctrl+Shift+\` | Toggle click-through (mouse passes through the overlay) |

The **eye button** in the title bar toggles stealth (capture-exclusion) on/off live.

---

## 6. Build a Windows installer

```powershell
npm run build:win
```

Behind a corporate proxy, run the packaging step in real PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; $env:NODE_OPTIONS = '--use-system-ca'; npm run build:win
```

Output lands in `dist/`:

- `ai-meeting-copilot-0.1.0-setup.exe` — the NSIS installer
- `win-unpacked/interview-copilot.exe` — the unpacked, runnable app

Other build commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check + build the production bundles (`out/`) |
| `npm run build:unpack` | Build an unpacked app folder (no installer) |
| `npm run typecheck` | Type-check only |

> The installer is **not code-signed**, so Windows SmartScreen shows an "unknown publisher"
> warning on first run — expected. To brand it, drop an `icon.ico` (256×256) into `build/`
> and rebuild; otherwise the default Electron icon is used.

---

## 7. Project layout

```
src/
  main/        Electron main process
    index.ts     window, stealth, hotkeys, tray, audio + IPC wiring
    deepgram.ts  Deepgram streaming WebSocket (diarization)
    azure.ts     Azure OpenAI streaming via Electron net.fetch
    settings.ts  local key store (userData JSON, .env fallback)
  preload/     contextBridge API exposed to the renderer
  renderer/    React + Tailwind UI (Setup + Overlay views, Settings panel)
electron-builder.yml   packaging config
electron.vite.config.ts
```

---

## 8. Troubleshooting

- **No transcript appears / Deepgram error badge** — corporate TLS inspection is breaking the
  speech connection. Enable **Allow insecure TLS** in Settings (or `DEEPGRAM_ALLOW_INSECURE_TLS=true`
  in `.env`) and restart. Proper fix: set `NODE_EXTRA_CA_CERTS` to your exported corporate root cert.
- **AI says "not configured"** — the Azure endpoint, key, or deployment is missing in Settings / `.env`.
- **Electron won't start after install** — make sure `NODE_OPTIONS` does **not** contain
  `--use-system-ca` when running `npm run dev`.
- **npm blocked by execution policy** — run
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` first.

---

## Security note

API keys are read by the **main process only** and are never exposed to the renderer/UI. Keep
your `.env` private (it is git-ignored) and prefer the in-app Settings store for real keys.
