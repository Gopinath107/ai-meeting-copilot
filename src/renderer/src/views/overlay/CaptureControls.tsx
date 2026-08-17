import type { DisplaySourceInfo } from '../../../../shared/capture'
import type { CaptureDisplayState } from './TranscriptPanel'

export type SpeechProvider = 'auto' | 'deepgram' | 'sarvam'

function Meter({
  label,
  level,
  seconds,
  active
}: {
  label: string
  level: number
  seconds: number
  active: boolean
}) {
  const percent = Math.min(100, Math.round(level * 160))
  return (
    <div className="flex-1">
      <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-400">
        <span>{label}</span>
        <span>{active ? `${seconds.toFixed(1)}s` : 'idle'}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-lime-300 transition-[width] duration-75"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export function CaptureControls({
  captureState,
  transcriptLineCount,
  hasSessionContent,
  isMeeting,
  micEnabled,
  screenEnabled,
  provider,
  audioError,
  levels,
  seconds,
  displaySources,
  selectedDisplaySourceId,
  loadingDisplaySources,
  screenError,
  screenReady,
  lastScreenSentAt,
  generatingMinutes,
  onStartOrPause,
  onNewSession,
  onGenerateMinutes,
  onToggleMic,
  onToggleScreen,
  onProviderChange,
  onSelectDisplaySource,
  onRefreshDisplaySources
}: {
  captureState: CaptureDisplayState
  transcriptLineCount: number
  hasSessionContent: boolean
  isMeeting: boolean
  micEnabled: boolean
  screenEnabled: boolean
  provider: SpeechProvider
  audioError: string | null
  levels: { system: number; mic: number }
  seconds: { system: number; mic: number }
  displaySources: DisplaySourceInfo[]
  selectedDisplaySourceId: string
  loadingDisplaySources: boolean
  screenError: string | null
  screenReady: boolean
  lastScreenSentAt: number | null
  generatingMinutes: boolean
  onStartOrPause: () => void
  onNewSession: () => void
  onGenerateMinutes: () => void
  onToggleMic: () => void
  onToggleScreen: () => void
  onProviderChange: (provider: SpeechProvider) => void
  onSelectDisplaySource: (id: string) => void
  onRefreshDisplaySources: () => void
}) {
  const capturing = captureState === 'active'
  const captureBusy = captureState !== 'idle'

  return (
    <div className="no-drag mx-3 mb-2 rounded-xl border border-white/10 bg-black/20 p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          onClick={onStartOrPause}
          disabled={captureState === 'finalizing'}
          className={`rounded-md px-3 py-1 text-xs font-semibold text-white ${
            captureBusy
              ? 'bg-red-500/80 hover:bg-red-500'
              : 'bg-emerald-500/90 hover:bg-emerald-400'
          } disabled:opacity-50`}
        >
          {captureState === 'finalizing'
            ? 'Finalizing…'
            : captureState === 'starting'
              ? 'Cancel start'
              : capturing
                ? 'Stop listening'
                : transcriptLineCount > 0
                  ? 'Resume listening'
                  : 'Start listening'}
        </button>
        <button
          onClick={onNewSession}
          disabled={captureBusy || !hasSessionContent}
          title="Clear the transcript, AI memory, summaries, participant names, minutes, and all session counters"
          className="rounded-md bg-white/5 px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-30"
        >
          New session
        </button>
        <button
          onClick={onGenerateMinutes}
          disabled={
            captureState === 'starting' || captureState === 'finalizing' || generatingMinutes
          }
          title="End the meeting and generate the Minutes of Meeting from the full transcript"
          className="rounded-md bg-amber-500/90 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-400 disabled:opacity-40"
        >
          {captureBusy ? 'End & Minutes' : 'Minutes of Meeting'}
        </button>
        <button
          onClick={onToggleMic}
          disabled={captureBusy}
          className={`rounded-md px-2 py-1 text-xs ${
            micEnabled ? 'bg-white/15 text-zinc-100' : 'bg-white/5 text-zinc-500'
          } disabled:opacity-50`}
        >
          Mic {micEnabled ? 'on' : 'off'}
        </button>
        <button
          onClick={onToggleScreen}
          disabled={captureBusy}
          title="Opt in to screen context. Choose a display below; one JPEG is sent only when you request screen-aware AI."
          className={`rounded-md px-2 py-1 text-xs ${
            screenEnabled ? 'bg-cyan-400/15 text-cyan-200' : 'bg-white/5 text-zinc-500'
          } disabled:opacity-50`}
        >
          Screen {screenEnabled ? 'on' : 'off'}
        </button>
        <select
          value={provider}
          onChange={(event) => onProviderChange(event.target.value as SpeechProvider)}
          disabled={captureBusy}
          title="Auto uses Sarvam first and falls back to Deepgram. Choose Deepgram directly for diarized speaker labels."
          className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-100 focus:border-indigo-400/50 focus:outline-none disabled:opacity-50"
        >
          <option value="auto">Auto (Sarvam + fallback)</option>
          <option value="sarvam">Sarvam · Indian English</option>
          <option value="deepgram">Deepgram · English + labels</option>
        </select>
        {audioError && (
          <span className="truncate text-[10px] text-red-300" title={audioError}>
            {audioError}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Meter
          label={isMeeting ? 'Meeting (system)' : 'Interviewer (system)'}
          level={levels.system}
          seconds={seconds.system}
          active={capturing}
        />
        {micEnabled && (
          <Meter label="You (mic)" level={levels.mic} seconds={seconds.mic} active={capturing} />
        )}
      </div>

      {screenEnabled && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
          <select
            value={selectedDisplaySourceId}
            onChange={(event) => onSelectDisplaySource(event.target.value)}
            disabled={captureBusy || loadingDisplaySources}
            aria-label="Screen source"
            className="max-w-64 rounded border border-white/10 bg-zinc-900 px-1.5 py-0.5 text-cyan-100 disabled:opacity-50"
          >
            {displaySources.length === 0 && <option value="">No screen sources</option>}
            {displaySources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}{source.isPrimary ? ' (primary)' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={onRefreshDisplaySources}
            disabled={captureBusy || loadingDisplaySources}
            className="rounded bg-white/5 px-1.5 py-0.5 text-zinc-300 hover:bg-white/10 disabled:opacity-50"
          >
            {loadingDisplaySources ? 'Refreshing…' : 'Refresh screens'}
          </button>
          <span className={screenError ? 'text-amber-300' : 'text-cyan-300'}>
            {screenError
              ? screenError
              : screenReady
                ? lastScreenSentAt
                  ? `Screen-aware · last frame sent to Azure AI at ${new Date(lastScreenSentAt).toLocaleTimeString()}.`
                  : 'Screen-aware · ready; no frame has been sent yet.'
                : captureState === 'starting'
                  ? 'Preparing the selected screen for visual context…'
                  : 'The selected source will be used when listening starts.'}
          </span>
        </div>
      )}
    </div>
  )
}
