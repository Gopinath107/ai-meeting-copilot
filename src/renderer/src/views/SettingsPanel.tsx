import { useEffect, useRef, useState } from 'react'
import type { ReleaseRuntimeInfo, UpdateStatus } from '../../../shared/release'

type Status = {
  sarvamKeySet: boolean
  deepgramKeySet: boolean
  azureKeySet: boolean
  azureEndpoint: string
  azureDeployment: string
  azureApiVersion: string
  allowInsecureTls: boolean
}

function Field({
  id,
  label,
  children,
  hint
}: {
  id: string
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-zinc-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none'

function describeUpdate(status: UpdateStatus | null): string {
  if (!status) return 'Loading update status…'
  switch (status.phase) {
    case 'disabled':
      return 'Automatic updates run in the installed Windows app.'
    case 'idle':
      return 'Ready to check for updates.'
    case 'checking':
      return 'Checking for updates…'
    case 'rollback-checking':
      return 'Checking the emergency rollback channel…'
    case 'available':
      return `Version ${status.targetVersion ?? 'new'} is available and will download automatically.`
    case 'rollback-available':
      return `Rollback ${status.targetVersion ?? ''} is available and will download automatically.`
    case 'downloading':
      return `Downloading update${typeof status.percent === 'number' ? ` · ${Math.round(status.percent)}%` : ''}…`
    case 'downloaded':
      return `Version ${status.targetVersion ?? 'update'} is ready to install.`
    case 'up-to-date':
      return 'You are using the latest available version.'
    case 'error':
      return status.message || 'The update check failed.'
  }
}

export default function SettingsPanel({
  onClose,
  onSaved,
  liveSession = false
}: {
  onClose: () => void
  onSaved?: () => void
  liveSession?: boolean
}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [sarvamApiKey, setSarvamApiKey] = useState('')
  const [deepgramApiKey, setDeepgramApiKey] = useState('')
  const [azureApiKey, setAzureApiKey] = useState('')
  const [azureEndpoint, setAzureEndpoint] = useState('')
  const [azureDeployment, setAzureDeployment] = useState('')
  const [azureApiVersion, setAzureApiVersion] = useState('')
  const [allowInsecureTls, setAllowInsecureTls] = useState(false)
  const [clearSarvamApiKey, setClearSarvamApiKey] = useState(false)
  const [clearDeepgramApiKey, setClearDeepgramApiKey] = useState(false)
  const [clearAzureApiKey, setClearAzureApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [releaseInfo, setReleaseInfo] = useState<ReleaseRuntimeInfo | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [updateError, setUpdateError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let active = true
    void window.api
      .getSettings()
      .then((s) => {
        if (!active) return
        setStatus(s)
        setAzureEndpoint(s.azureEndpoint)
        setAzureDeployment(s.azureDeployment)
        setAzureApiVersion(s.azureApiVersion)
        setAllowInsecureTls(s.allowInsecureTls)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'Settings could not be loaded.')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    const off = window.api.onUpdateStatus((next) => {
      if (active) setUpdateStatus(next)
    })
    void window.api
      .getReleaseInfo()
      .then((info) => {
        if (active) setReleaseInfo(info)
      })
      .catch((reason: unknown) => {
        if (active) {
          setUpdateError(reason instanceof Error ? reason.message : 'Build information is unavailable.')
        }
      })
    void window.api
      .getUpdateStatus()
      .then((next) => {
        if (active) setUpdateStatus(next)
      })
      .catch((reason: unknown) => {
        if (active) {
          setUpdateError(reason instanceof Error ? reason.message : 'Update status is unavailable.')
        }
      })
    return () => {
      active = false
      off()
    }
  }, [])

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function markEdited(): void {
    setSaved(false)
    setError('')
  }

  async function save(): Promise<void> {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      const next = await window.api.saveSettings({
        sarvamApiKey: sarvamApiKey || undefined,
        deepgramApiKey: deepgramApiKey || undefined,
        azureApiKey: azureApiKey || undefined,
        clearSarvamApiKey,
        clearDeepgramApiKey,
        clearAzureApiKey,
        azureEndpoint,
        azureDeployment,
        azureApiVersion,
        allowInsecureTls
      })
      setStatus(next)
      setSarvamApiKey('')
      setDeepgramApiKey('')
      setAzureApiKey('')
      setClearSarvamApiKey(false)
      setClearDeepgramApiKey(false)
      setClearAzureApiKey(false)
      setSaved(true)
      onSaved?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Settings could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  async function checkForUpdates(): Promise<void> {
    setCheckingUpdate(true)
    setUpdateError('')
    try {
      const started = await window.api.checkForUpdates()
      if (!started && updateStatus?.phase !== 'disabled') {
        setUpdateError('The update check could not be started.')
      }
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : 'The update check failed.')
    } finally {
      setCheckingUpdate(false)
    }
  }

  async function installUpdate(): Promise<void> {
    setUpdateError('')
    try {
      if (!(await window.api.installDownloadedUpdate())) {
        setUpdateError('The update is not ready to install yet.')
      }
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : 'The update could not be installed.')
    }
  }

  async function checkForRollback(): Promise<void> {
    if (!confirmRollback) {
      setConfirmRollback(true)
      setUpdateError('Click Confirm rollback check only when support has published an emergency rollback.')
      return
    }
    setConfirmRollback(false)
    setCheckingUpdate(true)
    setUpdateError('')
    try {
      if (!(await window.api.checkForRollback())) {
        setUpdateError('The emergency rollback check could not be started.')
      }
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : 'The rollback check failed.')
    } finally {
      setCheckingUpdate(false)
    }
  }

  const buildLabel = !releaseInfo
    ? '—'
    : releaseInfo.build?.runNumber
      ? `#${releaseInfo.build.runNumber}`
      : releaseInfo.build?.commit && releaseInfo.build.commit !== 'unknown'
        ? releaseInfo.build.commit.slice(0, 8)
        : releaseInfo.packaged
          ? 'metadata unavailable'
          : 'development'
  const updateBusy =
    checkingUpdate ||
    updateStatus?.phase === 'checking' ||
    updateStatus?.phase === 'rollback-checking' ||
    updateStatus?.phase === 'available' ||
    updateStatus?.phase === 'rollback-available' ||
    updateStatus?.phase === 'downloading' ||
    updateStatus?.phase === 'downloaded'

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="no-drag absolute inset-0 z-20 flex flex-col bg-zinc-900/95 backdrop-blur-sm"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span className="text-sm font-semibold text-zinc-100">Settings</span>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          Close
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <p className="text-[11px] text-zinc-500">
          Keys are stored locally on this device and used only to call the configured speech and AI
          services. Saved values are never shown again.
        </p>
        {liveSession && (
          <p role="status" className="rounded-lg border border-amber-400/20 bg-amber-400/10 p-2 text-[11px] text-amber-200">
            New speech settings take effect the next time listening starts. Your current transcript is preserved.
          </p>
        )}

        <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-semibold text-zinc-300">
            Speech-to-text · Sarvam AI <span className="text-emerald-300">(primary)</span>
          </div>
          <Field
            id="sarvam-api-key"
            label="API key"
            hint={
              status?.sarvamKeySet
                ? 'A key is already saved — leave blank to keep it.'
                : 'Used first for transcription; falls back to Deepgram if it fails.'
            }
          >
            <input
              id="sarvam-api-key"
              type="password"
              value={sarvamApiKey}
              onChange={(e) => {
                markEdited()
                setClearSarvamApiKey(false)
                setSarvamApiKey(e.target.value)
              }}
              placeholder={status?.sarvamKeySet ? '•••••••••• saved' : 'Paste Sarvam AI API key'}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          {status?.sarvamKeySet && (
            <button
              type="button"
              aria-pressed={clearSarvamApiKey}
              onClick={() => {
                markEdited()
                setSarvamApiKey('')
                setClearSarvamApiKey((value) => !value)
              }}
              className={`rounded px-2 py-1 text-[10px] ${clearSarvamApiKey ? 'bg-red-500/20 text-red-200' : 'bg-white/5 text-zinc-400 hover:bg-white/10'}`}
            >
              {clearSarvamApiKey ? 'Will remove on Save' : 'Remove saved key'}
            </button>
          )}
        </div>

        <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-semibold text-zinc-300">
            Speech-to-text · Deepgram <span className="text-zinc-500">(fallback)</span>
          </div>
          <Field
            id="deepgram-api-key"
            label="API key"
            hint={status?.deepgramKeySet ? 'A key is already saved — leave blank to keep it.' : undefined}
          >
            <input
              id="deepgram-api-key"
              type="password"
              value={deepgramApiKey}
              onChange={(e) => {
                markEdited()
                setClearDeepgramApiKey(false)
                setDeepgramApiKey(e.target.value)
              }}
              placeholder={status?.deepgramKeySet ? '•••••••••• saved' : 'Paste Deepgram API key'}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          {status?.deepgramKeySet && (
            <button
              type="button"
              aria-pressed={clearDeepgramApiKey}
              onClick={() => {
                markEdited()
                setDeepgramApiKey('')
                setClearDeepgramApiKey((value) => !value)
              }}
              className={`rounded px-2 py-1 text-[10px] ${clearDeepgramApiKey ? 'bg-red-500/20 text-red-200' : 'bg-white/5 text-zinc-400 hover:bg-white/10'}`}
            >
              {clearDeepgramApiKey ? 'Will remove on Save' : 'Remove saved key'}
            </button>
          )}
        </div>

        <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-semibold text-zinc-300">AI answers (Azure OpenAI)</div>
          <Field
            id="azure-api-key"
            label="API key"
            hint={status?.azureKeySet ? 'A key is already saved — leave blank to keep it.' : undefined}
          >
            <input
              id="azure-api-key"
              type="password"
              value={azureApiKey}
              onChange={(e) => {
                markEdited()
                setClearAzureApiKey(false)
                setAzureApiKey(e.target.value)
              }}
              placeholder={status?.azureKeySet ? '•••••••••• saved' : 'Paste Azure OpenAI API key'}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          {status?.azureKeySet && (
            <button
              type="button"
              aria-pressed={clearAzureApiKey}
              onClick={() => {
                markEdited()
                setAzureApiKey('')
                setClearAzureApiKey((value) => !value)
              }}
              className={`rounded px-2 py-1 text-[10px] ${clearAzureApiKey ? 'bg-red-500/20 text-red-200' : 'bg-white/5 text-zinc-400 hover:bg-white/10'}`}
            >
              {clearAzureApiKey ? 'Will remove on Save' : 'Remove saved key'}
            </button>
          )}
          <Field id="azure-endpoint" label="Endpoint">
            <input
              id="azure-endpoint"
              value={azureEndpoint}
              onChange={(e) => {
                markEdited()
                setAzureEndpoint(e.target.value)
              }}
              placeholder="https://your-resource.openai.azure.com"
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field
            id="azure-deployment"
            label="Deployment name"
            hint="Screen-aware answers require an Azure deployment that accepts image/vision input."
          >
            <input
              id="azure-deployment"
              value={azureDeployment}
              onChange={(e) => {
                markEdited()
                setAzureDeployment(e.target.value)
              }}
              placeholder="e.g. rudhra-gpt-5.4-mini"
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field id="azure-api-version" label="API version">
            <input
              id="azure-api-version"
              value={azureApiVersion}
              onChange={(e) => {
                markEdited()
                setAzureApiVersion(e.target.value)
              }}
              placeholder="2024-12-01-preview"
              className={inputClass}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold text-zinc-300">App updates</div>
            <span className="text-[10px] text-zinc-500">
              v{releaseInfo?.appVersion ?? '—'} · build {buildLabel}
            </span>
          </div>
          {releaseInfo?.build && (
            <div className="text-[10px] text-zinc-500">
              Electron {releaseInfo.build.electronVersion} · {releaseInfo.build.channel} ·{' '}
              {new Date(releaseInfo.build.builtAt).toLocaleDateString()}
            </div>
          )}
          <p
            role="status"
            className={`break-words text-[11px] ${updateStatus?.phase === 'error' || updateError ? 'text-red-300' : 'text-zinc-400'}`}
          >
            {updateError || describeUpdate(updateStatus)}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void checkForUpdates()}
              disabled={!updateStatus || updateStatus.phase === 'disabled' || updateBusy}
              className="rounded bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {checkingUpdate || updateStatus?.phase === 'checking' ? 'Checking…' : 'Check for updates'}
            </button>
            <button
              type="button"
              onClick={() => void checkForRollback()}
              disabled={!updateStatus || updateStatus.phase === 'disabled' || updateBusy}
              title="Use only when support has published a signed emergency rollback"
              className={`rounded px-2 py-1 text-[10px] font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                confirmRollback
                  ? 'bg-red-500/80 text-white hover:bg-red-400'
                  : 'bg-white/5 text-zinc-400 hover:bg-white/10'
              }`}
            >
              {confirmRollback ? 'Confirm rollback check' : 'Emergency rollback'}
            </button>
            {updateStatus?.phase === 'downloaded' && (
              <button
                type="button"
                onClick={() => void installUpdate()}
                className="rounded bg-indigo-500 px-2 py-1 text-[10px] font-semibold text-white hover:bg-indigo-400"
              >
                Restart and install
              </button>
            )}
          </div>
        </div>

        <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 p-3">
          <input
            type="checkbox"
            checked={allowInsecureTls}
            onChange={(e) => {
              markEdited()
              setAllowInsecureTls(e.target.checked)
            }}
            className="mt-0.5"
          />
          <span className="text-[11px] text-zinc-400">
            <span className="font-medium text-zinc-200">Allow insecure TLS for Deepgram.</span> Only
            enable this on a trusted corporate network that inspects HTTPS traffic and breaks the
            certificate chain. Sarvam certificate verification remains enabled.
          </span>
        </label>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
        <span
          role={error ? 'alert' : 'status'}
          className={`text-[11px] ${error ? 'text-red-300' : 'text-emerald-300'}`}
        >
          {error || (saved ? 'Saved.' : '')}
        </span>
        <button
          onClick={() => void save()}
          disabled={saving || status === null}
          className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
