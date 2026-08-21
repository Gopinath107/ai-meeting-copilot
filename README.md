# AI Meeting Copilot

A private, real-time interview and meeting copilot for Windows. It listens to meeting audio,
transcribes it live (Sarvam AI with Deepgram fallback), and streams AI answer suggestions
(Azure OpenAI) into a
floating overlay that is **hidden from screen sharing / recording**.

- **Stealth overlay** — excluded from screen capture (Zoom / Teams / Meet / OBS / Game Bar).
  You see it; people viewing your shared screen do not.
- **Live transcription** through Sarvam AI or Deepgram. Deepgram adds multi-speaker
  diarization ("Interviewer 1/2/3").
- **Screen-aware answers** that combine the transcript with an on-demand current-screen snapshot.
- **Progressive AI answers** grounded in your résumé + job description: a three-point
  speaking outline appears first, followed by the complete streamed answer.
- **Manual question box** for scenario / long questions.
- 100% Node.js / TypeScript — no Python required.

> Honest limit: stealth defeats *software* capture only. It does **not** defeat a phone or a
> second camera physically pointed at your screen.

---

## 1. Prerequisites

- **Windows 10/11 (x64)**
- **Node.js 22.13+** (or Node 24+; setup feature-detects `--use-system-ca`)
- **npm** (ships with Node)
- API keys:
  - At least one speech provider:
    - **Sarvam AI** API key (primary in Auto mode)
    - **Deepgram** API key (automatic fallback and speaker labels)
  - **Azure OpenAI** resource: endpoint, API key, and a chat deployment (e.g. `gpt-4o`)
    - Screen-aware mode additionally requires a deployment that supports image/vision input.

---

## 2. Install

```powershell
npm install
```

### Behind a corporate TLS-inspection proxy

If `npm install` (or the Electron binary download) fails with
`unable to get local issuer certificate`, use Node 22/24 and trust the Windows certificate store
for the install (the automated setup feature-detects this flag):

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
3. Paste a Sarvam and/or Deepgram key, plus the Azure key, endpoint, deployment, and API version.
4. **Save.**

Keys are stored locally in your user app-data folder
(`%APPDATA%\interview-copilot\settings.json`) and are never shown back in the UI.

### Option B — `.env` file (handy for development)

```powershell
Copy-Item .env.example .env
```

Then edit `.env`:

```ini
SARVAM_API_KEY=your_sarvam_key
DEEPGRAM_API_KEY=your_optional_deepgram_fallback_key

AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your_azure_key
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
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
résumé (PDF / DOCX / TXT / Markdown), then **Start session**. Documents are limited to
8 MB each; reference selections allow up to 8 files and 24 MB total before extraction.
PDFs are capped at 100 pages, DOCX archives are checked for excessive expansion, and parsing has
a bounded timeout so a malformed document cannot silently stall normal setup.

---

## 5. Use it

1. Join your interview through your **own** meeting link as normal (do not bot-join).
2. In the overlay, click **Start listening** (and toggle **Mic** if you want your own voice
   transcribed too).
3. Turn **Screen on** before starting if you want visual context, then choose the display that
   contains the meeting, browser, code, or document you want the AI to see. The app keeps that
   display track locally and sends one compressed frame only when an answer or user-triggered
   analysis request runs; it does not continuously upload screen video.
4. AI answers stream automatically when an interviewer asks a question, or trigger them
   manually with the hotkey / **Answer** button, or type a question in the manual box. In
   interview mode you can choose concise, standard, or detailed depth, regenerate the exact
   captured question, and pin completed answers for quick reference.
5. Click **See screen** to request an immediate screen-focused answer or meeting analysis.

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

- `ai-meeting-copilot-0.1.0-windows-x64-setup.exe` — the NSIS installer
- `win-unpacked/interview-copilot.exe` — the unpacked, runnable app

Other build commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check + build the production bundles (`out/`) |
| `npm run build:unpack` | Build an unpacked app folder (no installer) |
| `npm run typecheck` | Type-check only |
| `npm run lint` | Run static lint checks |
| `npm test` | Run the automated regression suite |
| `npm run check` | Run lint, type-checking, and tests |

Local `npm run build:win` output is intentionally unsigned and is for development/testing only.
Production releases must use the signed tag workflow described in [docs/RELEASE.md](docs/RELEASE.md);
that workflow refuses to publish without the signing certificate, verifies Authenticode,
publishes SHA-256 checksums and update metadata, and preserves a controlled rollback path.

---

## 7. Project layout

```
src/
  main/        Electron main process
    index.ts     window, stealth, hotkeys, tray, audio + IPC wiring
    sarvam.ts    Sarvam streaming WebSocket (Auto-mode primary)
    deepgram.ts  Deepgram streaming WebSocket (diarization)
    azure.ts     Azure OpenAI streaming via Electron net.fetch
    settings.ts  local key store (userData JSON, .env fallback)
  preload/     contextBridge API exposed to the renderer
  renderer/    React + Tailwind UI (Setup + Overlay views, Settings panel)
  shared/      IPC-safe types shared by main, preload, and renderer
electron-builder.yml   packaging config
electron.vite.config.ts
```

---

## 8. Troubleshooting

- **No transcript appears** — confirm the selected provider has a key. Auto mode tries Sarvam first
  and falls back to Deepgram. Prefer installing the corporate root CA when TLS inspection breaks a
  speech connection; disabling certificate verification should only be a short-lived diagnostic.
- **See screen has no image** — turn Screen on before listening, select the correct display, and
  restart capture after changing displays. If Teams/Zoom or a browser moved monitors, stop,
  refresh the display list, select that full display, and start again. Protected/DRM video can
  remain black because Windows intentionally prevents applications from capturing it.
- **AI says "not configured"** — the Azure endpoint, key, or deployment is missing in Settings / `.env`.
- **Electron won't start after install** — make sure `NODE_OPTIONS` does **not** contain
  `--use-system-ca` when running `npm run dev`.
- **npm blocked by execution policy** — run
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force` first.

---

## Security note

API keys are read by the **main process only** and are never shown back in the renderer/UI. A
development `.env` must remain untracked and must never be committed; prefer in-app Settings for
local use and rotate any key that has ever entered Git history.
Screen snapshots are opt-in and are sent to the configured Azure AI deployment only when an
answer or explicit screen/analysis request is made. They are not added to conversation history,
summaries, minutes, or local files.

## Deployment scope

This is an Electron desktop application, not a browser-hosted website. The renderer requires the
trusted preload bridge (`window.api`) and is intentionally not deployable to Vercel or another
static web host by itself.
