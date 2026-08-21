import { useCallback, useEffect, useState } from 'react'
import type { SessionConfig, SessionMode } from '../App'
import SettingsPanel from './SettingsPanel'
import { hasAiConfiguration, hasSpeechConfiguration } from './overlay/uiState'

type SettingsStatus = Awaited<ReturnType<typeof window.api.getSettings>>
type ShortcutHealth = Awaited<ReturnType<typeof window.api.getShortcutHealth>>

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
  const [settingsStatus, setSettingsStatus] = useState<SettingsStatus | null>(null)
  const [shortcutHealth, setShortcutHealth] = useState<ShortcutHealth | null>(null)
  const [preflightError, setPreflightError] = useState('')
  const [checkingPreflight, setCheckingPreflight] = useState(true)
  // Meeting-mode context
  const [userName, setUserName] = useState('')
  const [projectContext, setProjectContext] = useState('')
  const [techStack, setTechStack] = useState('')

  const refreshPreflight = useCallback(async (): Promise<void> => {
    setCheckingPreflight(true)
    setPreflightError('')
    try {
      const [settings, shortcuts] = await Promise.all([
        window.api.getSettings(),
        window.api.getShortcutHealth()
      ])
      setSettingsStatus(settings)
      setShortcutHealth(shortcuts)
    } catch (error) {
      setSettingsStatus(null)
      setPreflightError(
        error instanceof Error ? error.message : 'The saved configuration could not be checked.'
      )
    } finally {
      setCheckingPreflight(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshPreflight(), 0)
    const off = window.api.onShortcutHealthChanged(setShortcutHealth)
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [refreshPreflight])

  const speechConfigured = hasSpeechConfiguration(settingsStatus)
  const aiConfigured = hasAiConfiguration(settingsStatus)

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
        <div
          role="tablist"
          aria-label="Session type"
          className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-white/5 p-1"
        >
          {(['interview', 'meeting', 'consultant'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
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
          <label htmlFor="session-role" className="mb-1 block text-xs font-medium text-zinc-400">
            {mode !== 'interview' ? 'Your role' : 'Role / position'}
          </label>
          <input
            id="session-role"
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
              <label htmlFor="user-name" className="mb-1 block text-xs font-medium text-zinc-400">
                Your name <span className="font-normal text-amber-300">· recommended for auto-answer</span>
              </label>
              <input
                id="user-name"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Used to detect when a question is aimed at you"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
              />
              {!userName.trim() && (
                <p className="mt-1 text-[10px] text-amber-300/90">
                  Without your name, questions addressed to you by name may not trigger auto-answer.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="project-context" className="mb-1 block text-xs font-medium text-zinc-400">
                Project / application
              </label>
              <textarea
                id="project-context"
                value={projectContext}
                onChange={(e) => setProjectContext(e.target.value)}
                placeholder="What is the app, and what feature(s) are you discussing? e.g. B2B invoicing app — reviewing the login / auth flow…"
                rows={4}
                className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="tech-stack" className="mb-1 block text-xs font-medium text-zinc-400">Tech stack</label>
              <input
                id="tech-stack"
                value={techStack}
                onChange={(e) => setTechStack(e.target.value)}
                placeholder={mode === 'consultant' ? 'Java 21, Spring Boot, GraphQL, Insomnia' : 'e.g. React, Node.js, PostgreSQL, AWS'}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/50 focus:outline-none"
              />
            </div>
          </>
        )}

        {mode === 'interview' && (
          <div>
            <label htmlFor="job-description" className="mb-1 block text-xs font-medium text-zinc-400">Job description</label>
            <textarea
              id="job-description"
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

        <section
          aria-labelledby="preflight-title"
          className="rounded-xl border border-white/10 bg-black/20 p-3"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="preflight-title" className="text-xs font-semibold text-zinc-200">
              Ready to start
            </h2>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="rounded bg-white/10 px-2 py-1 text-[11px] text-zinc-200 hover:bg-white/15"
            >
              Configure services
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <div className={speechConfigured ? 'text-emerald-300' : 'text-red-300'}>
              Speech · {checkingPreflight ? 'Checking…' : speechConfigured ? 'Configured' : 'API key required'}
            </div>
            <div className={aiConfigured ? 'text-emerald-300' : 'text-amber-300'}>
              AI answers · {checkingPreflight ? 'Checking…' : aiConfigured ? 'Configured' : 'Not configured'}
            </div>
            <div className="text-zinc-400">System audio · tested when listening starts</div>
            <div className="text-zinc-400">Screen & mic · optional, tested in session</div>
            <div className={shortcutHealth?.allRegistered ? 'text-emerald-300' : 'text-amber-300'}>
              Shortcuts · {shortcutHealth ? `${shortcutHealth.registered}/${shortcutHealth.total} active` : 'Checking…'}
            </div>
            {shortcutHealth && !shortcutHealth.allRegistered && (
              <button
                type="button"
                onClick={() => {
                  void window.api.retryShortcuts().then(setShortcutHealth).catch((error: unknown) => {
                    setPreflightError(error instanceof Error ? error.message : 'Shortcuts could not be retried.')
                  })
                }}
                className="justify-self-start rounded bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-200 hover:bg-amber-400/25"
              >
                Retry shortcuts
              </button>
            )}
          </div>
          {shortcutHealth && !shortcutHealth.allRegistered && (
            <details className="mt-2 rounded border border-amber-400/20 bg-amber-400/5 px-2 py-1 text-[10px] text-amber-200">
              <summary className="cursor-pointer font-medium">Show shortcut conflicts</summary>
              <ul className="mt-1 space-y-1">
                {shortcutHealth.shortcuts
                  .filter((shortcut) => !shortcut.registered)
                  .map((shortcut) => (
                    <li key={shortcut.id}>
                      <span className="font-medium">{shortcut.label}</span> · {shortcut.accelerator}
                      {shortcut.error ? ` — ${shortcut.error}` : ' — already in use or unavailable'}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {!aiConfigured && !checkingPreflight && (
            <p className="mt-2 text-[10px] text-amber-300">
              Transcription can run, but Answer, analysis and recap need Azure AI settings.
            </p>
          )}
          {preflightError && <p role="alert" className="mt-2 text-[11px] text-red-300">{preflightError}</p>}
        </section>
      </div>

      {/* Footer */}
      <div className="no-drag border-t border-white/10 px-4 py-3">
        <button
          type="button"
          onClick={() => {
            if (!speechConfigured) {
              setPreflightError('Add a Sarvam or Deepgram API key before starting transcription.')
              setShowSettings(true)
              return
            }
            onStart({
              mode,
              role,
              resumeName,
              resumeText,
              jobDescription,
              docNames,
              docsText,
              userName,
              projectContext,
              techStack
            })
          }}
          disabled={busy !== null || checkingPreflight || !speechConfigured}
          className="w-full rounded-lg bg-indigo-500 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode === 'consultant' ? 'Start consultant' : mode === 'meeting' ? 'Start meeting' : 'Start session'}
        </button>
      </div>

      {showSettings && (
        <SettingsPanel
          onSaved={() => void refreshPreflight()}
          onClose={() => {
            setShowSettings(false)
            void refreshPreflight()
          }}
        />
      )}
    </div>
  )
}
