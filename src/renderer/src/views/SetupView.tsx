import { useState } from 'react'
import type { SessionConfig } from '../App'
import SettingsPanel from './SettingsPanel'

function FileRow({
  label,
  hint,
  value,
  busy,
  onChoose
}: {
  label: string
  hint: string
  value?: string
  busy?: boolean
  onChoose: () => void
}) {
  return (
    <div className="no-drag flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm text-zinc-100">{label}</div>
        <div className="truncate text-[11px] text-zinc-400">{value || hint}</div>
      </div>
      <button
        onClick={onChoose}
        disabled={busy}
        className="shrink-0 rounded-md bg-white/10 px-3 py-1 text-xs text-zinc-100 hover:bg-white/20 disabled:opacity-50"
      >
        {busy ? 'Reading…' : 'Choose'}
      </button>
    </div>
  )
}

export default function SetupView({ onStart }: { onStart: (config: SessionConfig) => void }) {
  const [role, setRole] = useState('')
  const [meetingUrl, setMeetingUrl] = useState('')
  const [resumeName, setResumeName] = useState<string>()
  const [resumeText, setResumeText] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [docNames, setDocNames] = useState<string[]>([])
  const [docsText, setDocsText] = useState('')
  const [busy, setBusy] = useState<'resume' | 'extra' | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  async function pick(kind: 'resume' | 'extra'): Promise<void> {
    setBusy(kind)
    try {
      const res = await window.api.pickDocument(kind)
      if (res && res.names.length) {
        if (kind === 'resume') {
          setResumeName(res.names[0])
          setResumeText(res.text)
        } else {
          setDocNames(res.names)
          setDocsText(res.text)
        }
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Title bar (draggable) */}
      <div className="drag flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-2.5 w-2.5 rounded-full bg-indigo-400" />
          <span className="text-sm font-semibold text-zinc-100">Interview Copilot</span>
        </div>
        <div className="no-drag flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Settings
          </button>
          <button
            onClick={() => window.api.hide()}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Hide
          </button>
          <button
            onClick={() => window.api.quit()}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-red-500/20 hover:text-red-200"
          >
            Quit
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="no-drag flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Role / position</label>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Senior Backend Engineer"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Meeting link (yours)</label>
          <input
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            placeholder="Paste your Zoom / Meet / Teams link"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            You join the call normally; the app listens to your system audio locally (stays hidden).
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Job description</label>
          <textarea
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            placeholder="Paste the job description here…"
            rows={5}
            className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-medium text-zinc-400">Documents</label>
          <FileRow
            label="Résumé"
            hint="PDF, DOCX or TXT"
            value={
              resumeName
                ? `${resumeName}${resumeText ? ` · ${resumeText.length.toLocaleString()} chars parsed` : ' · could not read text'}`
                : undefined
            }
            busy={busy === 'resume'}
            onChoose={() => pick('resume')}
          />
          <FileRow
            label="Extra docs"
            hint="Notes, portfolio, projects (optional)"
            value={
              docNames.length
                ? `${docNames.length} file(s)${docsText ? ` · ${docsText.length.toLocaleString()} chars` : ''}`
                : undefined
            }
            busy={busy === 'extra'}
            onChoose={() => pick('extra')}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="no-drag border-t border-white/10 px-4 py-3">
        <button
          onClick={() =>
            onStart({ role, meetingUrl, resumeName, resumeText, jobDescription, docNames, docsText })
          }
          className="w-full rounded-lg bg-indigo-500 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400"
        >
          Start session
        </button>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}
