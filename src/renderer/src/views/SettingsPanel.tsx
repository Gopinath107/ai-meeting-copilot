import { useEffect, useState } from 'react'

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
  label,
  children,
  hint
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-zinc-400">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none'

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [sarvamApiKey, setSarvamApiKey] = useState('')
  const [deepgramApiKey, setDeepgramApiKey] = useState('')
  const [azureApiKey, setAzureApiKey] = useState('')
  const [azureEndpoint, setAzureEndpoint] = useState('')
  const [azureDeployment, setAzureDeployment] = useState('')
  const [azureApiVersion, setAzureApiVersion] = useState('')
  const [allowInsecureTls, setAllowInsecureTls] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setStatus(s)
      setAzureEndpoint(s.azureEndpoint)
      setAzureDeployment(s.azureDeployment)
      setAzureApiVersion(s.azureApiVersion)
      setAllowInsecureTls(s.allowInsecureTls)
    })
  }, [])

  async function save(): Promise<void> {
    setSaving(true)
    setSaved(false)
    try {
      const next = await window.api.saveSettings({
        sarvamApiKey: sarvamApiKey || undefined,
        deepgramApiKey: deepgramApiKey || undefined,
        azureApiKey: azureApiKey || undefined,
        azureEndpoint,
        azureDeployment,
        azureApiVersion,
        allowInsecureTls
      })
      setStatus(next)
      setSarvamApiKey('')
      setDeepgramApiKey('')
      setAzureApiKey('')
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="no-drag absolute inset-0 z-20 flex flex-col bg-zinc-900/95 backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <span className="text-sm font-semibold text-zinc-100">Settings · API keys</span>
        <button
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          Close
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <p className="text-[11px] text-zinc-500">
          Keys are stored locally on this device (app data folder) and never leave the app except to
          call the speech and AI services. They are not shown again after saving.
        </p>

        <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-semibold text-zinc-300">
            Speech-to-text · Sarvam AI <span className="text-emerald-300">(primary)</span>
          </div>
          <Field
            label="API key"
            hint={
              status?.sarvamKeySet
                ? 'A key is already saved — leave blank to keep it.'
                : 'Used first for transcription; falls back to Deepgram if it fails.'
            }
          >
            <input
              type="password"
              value={sarvamApiKey}
              onChange={(e) => setSarvamApiKey(e.target.value)}
              placeholder={status?.sarvamKeySet ? '•••••••••• saved' : 'Paste Sarvam AI API key'}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-semibold text-zinc-300">
            Speech-to-text · Deepgram <span className="text-zinc-500">(fallback)</span>
          </div>
          <Field
            label="API key"
            hint={status?.deepgramKeySet ? 'A key is already saved — leave blank to keep it.' : undefined}
          >
            <input
              type="password"
              value={deepgramApiKey}
              onChange={(e) => setDeepgramApiKey(e.target.value)}
              placeholder={status?.deepgramKeySet ? '•••••••••• saved' : 'Paste Deepgram API key'}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
        </div>

        <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-xs font-semibold text-zinc-300">AI answers (Azure OpenAI)</div>
          <Field
            label="API key"
            hint={status?.azureKeySet ? 'A key is already saved — leave blank to keep it.' : undefined}
          >
            <input
              type="password"
              value={azureApiKey}
              onChange={(e) => setAzureApiKey(e.target.value)}
              placeholder={status?.azureKeySet ? '•••••••••• saved' : 'Paste Azure OpenAI API key'}
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field label="Endpoint">
            <input
              value={azureEndpoint}
              onChange={(e) => setAzureEndpoint(e.target.value)}
              placeholder="https://your-resource.openai.azure.com"
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field label="Deployment name">
            <input
              value={azureDeployment}
              onChange={(e) => setAzureDeployment(e.target.value)}
              placeholder="e.g. rudhra-gpt-5.4-mini"
              className={inputClass}
              autoComplete="off"
            />
          </Field>
          <Field label="API version">
            <input
              value={azureApiVersion}
              onChange={(e) => setAzureApiVersion(e.target.value)}
              placeholder="2024-12-01-preview"
              className={inputClass}
              autoComplete="off"
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 p-3">
          <input
            type="checkbox"
            checked={allowInsecureTls}
            onChange={(e) => setAllowInsecureTls(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-[11px] text-zinc-400">
            <span className="font-medium text-zinc-200">Allow insecure TLS for Deepgram.</span> Only
            enable this on a trusted corporate network that inspects HTTPS traffic and breaks the
            certificate chain. Disables certificate verification for the speech connection.
          </span>
        </label>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
        <span className="text-[11px] text-emerald-300">{saved ? 'Saved.' : ''}</span>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
