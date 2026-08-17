import { useState } from 'react'
import type { SessionConfig, SessionMode } from '../App'
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
  const [mode, setMode] = useState<SessionMode>('interview')
  const [role, setRole] = useState('')
  const [meetingUrl, setMeetingUrl] = useState('')
  const [resumeName, setResumeName] = useState<string>()
  const [resumeText, setResumeText] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [docNames, setDocNames] = useState<string[]>([])
  const [docsText, setDocsText] = useState('')
  const [busy, setBusy] = useState<'resume' | 'extra' | null>(null)
  const [documentNotice, setDocumentNotice] = useState<{
    kind: 'warning' | 'error'
    message: string
  } | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Meeting-mode context
  const [userName, setUserName] = useState('')
  const [projectContext, setProjectContext] = useState('')
  const [techStack, setTechStack] = useState('')

  async function pick(kind: 'resume' | 'extra'): Promise<void> {
    setBusy(kind)
    setDocumentNotice(null)
    try {
      const res = await window.api.pickDocument(kind)
      if (!res) return
      if (res.names.length) {
        if (kind === 'resume') {
          setResumeName(res.names[0])
          setResumeText(res.text)
        } else {
          setDocNames(res.names)
          setDocsText(res.text)
        }
      }
      if (res.warnings.length) {
        setDocumentNotice({ kind: 'warning', message: res.warnings.join(' ') })
      }
    } catch (error) {
      setDocumentNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The selected document could not be read.'
      })
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
          <span className="text-sm font-semibold text-zinc-100">
            {mode === 'consultant'
              ? 'Optum Technical Consultant'
              : mode === 'meeting'
                ? 'Meeting Copilot'
                : 'Interview Copilot'}
          </span>
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
        {/* Mode selector */}
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-white/5 p-1">
          {(['interview', 'meeting', 'consultant'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                mode === m
                  ? 'bg-indigo-500 text-white'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
              }`}
            >
              {m === 'interview' ? 'Interview' : m === 'meeting' ? 'Meeting' : 'Consultant'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-zinc-500">
          {mode === 'consultant'
            ? 'Optum-focused Java, Spring Boot, GraphQL and Insomnia guidance from requirements through implementation and API testing.'
            : mode === 'meeting'
            ? 'Analyzes the team discussion live — flags issues, suggests fixes and follow-ups, and answers questions aimed at you.'
            : 'Streams first-person answer suggestions when the interviewer asks a question.'}
        </p>

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">
            {mode !== 'interview' ? 'Your role' : 'Role / position'}
          </label>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder={
              mode === 'consultant'
                ? 'e.g. Java / GraphQL Engineer'
                : mode === 'meeting'
                  ? 'e.g. Backend Lead'
                  : 'e.g. Senior Backend Engineer'
            }
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
          />
        </div>

        {mode !== 'interview' && (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Your name</label>
              <input
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Used to detect when a question is aimed at you"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Project / application
              </label>
              <textarea
                value={projectContext}
                onChange={(e) => setProjectContext(e.target.value)}
                placeholder="What is the app, and what feature(s) are you discussing? e.g. B2B invoicing app — reviewing the login / auth flow…"
                rows={4}
                className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">Tech stack</label>
              <input
                value={techStack}
                onChange={(e) => setTechStack(e.target.value)}
                placeholder={mode === 'consultant' ? 'Java 21, Spring Boot, GraphQL, Insomnia' : 'e.g. React, Node.js, PostgreSQL, AWS'}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
              />
            </div>
          </>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-400">Meeting link (yours)</label>
          <input
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            placeholder="Paste your Zoom / Meet / Teams link"
            className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            You join normally. The app captures system audio; optional Screen mode adds one current
            frame to AI requests instead of continuously uploading video.
          </p>
        </div>

        {mode === 'interview' && (
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
        )}

        <div className="space-y-2">
          <label className="block text-xs font-medium text-zinc-400">Documents</label>
          {mode === 'interview' && (
            <FileRow
              label="Résumé"
              hint="PDF, DOCX, TXT or Markdown · up to 8 MB"
              value={
                resumeName
                  ? `${resumeName}${resumeText ? ` · ${resumeText.length.toLocaleString()} chars parsed` : ' · could not read text'}`
                  : undefined
              }
              busy={busy !== null}
              onChoose={() => pick('resume')}
            />
          )}
          <FileRow
            label={mode !== 'interview' ? 'Reference docs' : 'Extra docs'}
            hint={
              mode !== 'interview'
                ? 'Specs, tickets, design docs · up to 8 files'
                : 'Notes, portfolio, projects · up to 8 files'
            }
            value={
              docNames.length
                ? `${docNames.length} file(s)${docsText ? ` · ${docsText.length.toLocaleString()} chars` : ''}`
                : undefined
            }
            busy={busy !== null}
            onChoose={() => pick('extra')}
          />
          {documentNotice && (
            <p
              role={documentNotice.kind === 'error' ? 'alert' : 'status'}
              className={`text-[11px] ${
                documentNotice.kind === 'error' ? 'text-red-300' : 'text-amber-300'
              }`}
            >
              {documentNotice.message}
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="no-drag border-t border-white/10 px-4 py-3">
        <button
          onClick={() =>
            onStart({
              mode,
              role,
              meetingUrl,
              resumeName,
              resumeText,
              jobDescription,
              docNames,
              docsText,
              userName,
              projectContext,
              techStack
            })
          }
          disabled={busy !== null}
          className="w-full rounded-lg bg-indigo-500 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode === 'consultant' ? 'Start consultant' : mode === 'meeting' ? 'Start meeting' : 'Start session'}
        </button>
      </div>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  )
}
