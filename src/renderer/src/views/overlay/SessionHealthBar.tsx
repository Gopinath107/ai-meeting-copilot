import type { CaptureDisplayState } from './TranscriptPanel'
import { captureHealth, speechHealth, statusTone, type HealthItem } from './uiState'

const toneClass = {
  ready: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  working: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  idle: 'border-white/10 bg-white/5 text-zinc-400',
  error: 'border-red-400/25 bg-red-400/10 text-red-200'
} as const

function HealthPill({ item }: { item: HealthItem }) {
  return (
    <span
      title={item.detail}
      aria-label={`${item.label}: ${item.value}`}
      className={`flex min-w-0 flex-col rounded-md border px-1.5 py-1 text-[10px] ${toneClass[item.tone]}`}
    >
      <span className="flex min-w-0 items-center gap-1">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            item.tone === 'ready'
              ? 'bg-emerald-300'
              : item.tone === 'working'
                ? 'bg-amber-300'
                : item.tone === 'error'
                  ? 'bg-red-300'
                  : 'bg-zinc-500'
          }`}
        />
        <span className="truncate font-medium">{item.label}</span>
      </span>
      <span className="truncate pl-2.5 text-[9px] opacity-75">{item.value}</span>
    </span>
  )
}

export function SessionHealthBar({
  captureState,
  systemStatus,
  micStatus,
  speechConfigured,
  micEnabled,
  screenEnabled,
  screenReady,
  screenError,
  screenLikelyBlank,
  aiConfigured,
  aiBusy,
  aiError,
  audioError,
  collapsed,
  onToggleCollapsed,
  onTestScreen
}: {
  captureState: CaptureDisplayState
  systemStatus: string
  micStatus: string
  speechConfigured: boolean
  micEnabled: boolean
  screenEnabled: boolean
  screenReady: boolean
  screenError: string | null
  screenLikelyBlank: boolean
  aiConfigured: boolean
  aiBusy: boolean
  aiError: string | null
  audioError: string | null
  collapsed: boolean
  onToggleCollapsed: () => void
  onTestScreen: () => void
}) {
  const system = captureHealth(captureState, audioError)
  const speech = speechHealth(systemStatus, captureState, speechConfigured)
  const micTone = statusTone(micStatus)
  const items: HealthItem[] = [
    {
      label: 'System',
      ...system,
      detail: audioError ?? 'System audio capture'
    },
    {
      label: 'Speech',
      ...speech,
      detail: systemStatus || 'Speech-to-text provider'
    },
    {
      label: 'Mic',
      value: !micEnabled
        ? 'Off'
        : captureState === 'active' && micTone === 'ready'
          ? 'Ready'
          : captureState === 'active'
            ? micTone === 'error'
              ? 'Failed'
              : 'Starting'
            : 'Armed',
      tone: !micEnabled
        ? 'idle'
        : micTone === 'error'
          ? 'error'
          : captureState === 'active' && micTone === 'ready'
            ? 'ready'
            : 'working',
      detail: micStatus || (micEnabled ? 'Your voice will be included' : 'Your voice is not captured')
    },
    {
      label: 'Screen',
      value: !screenEnabled
        ? 'Off'
        : screenError
          ? 'Failed'
          : screenLikelyBlank
          ? 'Blank frame'
          : screenReady
            ? 'Ready'
            : captureState === 'starting'
              ? 'Starting'
              : 'Not active',
      tone: !screenEnabled
        ? 'idle'
        : screenError || screenLikelyBlank
          ? 'error'
          : screenReady
            ? 'ready'
            : captureState === 'starting'
              ? 'working'
              : 'idle',
      detail: screenError ?? (screenLikelyBlank
        ? 'The local preview looks blank; choose another source or check capture permissions.'
        : 'A frame is sent only for a screen-aware AI request.'
      )
    },
    {
      label: 'AI',
      value: !aiConfigured ? 'Configure' : aiError ? 'Failed' : aiBusy ? 'Working' : 'Ready',
      tone: !aiConfigured || aiError ? 'error' : aiBusy ? 'working' : 'ready',
      detail: aiError ?? 'Azure AI answer service'
    }
  ]

  const toggle = (
    <button
      type="button"
      onClick={onToggleCollapsed}
      aria-expanded={!collapsed}
      aria-controls="session-health-details"
      aria-label={collapsed ? 'Show session status details' : 'Hide session status details'}
      title={collapsed ? 'Show session status' : 'Hide session status to give the answer more room'}
      className="shrink-0 rounded-md bg-white/5 px-1.5 py-1 text-[10px] font-medium text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
    >
      {collapsed ? 'Status ▸' : 'Status ▾'}
    </button>
  )

  if (collapsed) {
    // Folding the pills away must never fold away a problem: anything in an error
    // state stays on screen, and only a healthy session collapses to a count.
    const problems = items.filter((item) => item.tone === 'error')
    return (
      <div
        className="no-drag mx-3 mb-1.5 flex shrink-0 items-center gap-1.5"
        aria-label="Session readiness"
      >
        {toggle}
        <span
          role="status"
          aria-live="polite"
          title={problems.map((item) => item.detail).filter(Boolean).join('\n') || undefined}
          className={`min-w-0 flex-1 truncate text-[10px] ${
            problems.length > 0 ? 'text-red-200' : 'text-zinc-500'
          }`}
        >
          {problems.length > 0
            ? problems.map((item) => `${item.label}: ${item.value}`).join(' · ')
            : `${items.filter((item) => item.tone === 'ready').length}/${items.length} ready`}
        </span>
        {screenEnabled && (
          <button
            type="button"
            onClick={onTestScreen}
            disabled={!screenReady}
            className="shrink-0 rounded-md bg-cyan-500/15 px-2 py-1 text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
          >
            Test screen
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="no-drag mx-3 mb-2 flex shrink-0 items-stretch gap-1.5" aria-label="Session readiness">
      <div
        id="session-health-details"
        className="grid min-w-0 flex-1 grid-cols-5 gap-1"
        role="status"
        aria-live="polite"
      >
        {items.map((item) => (
          <HealthPill key={item.label} item={item} />
        ))}
      </div>
      {screenEnabled && (
        <button
          type="button"
          onClick={onTestScreen}
          disabled={!screenReady}
          className="shrink-0 rounded-md bg-cyan-500/15 px-2 py-1 text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
        >
          Test screen
        </button>
      )}
      {toggle}
    </div>
  )
}
