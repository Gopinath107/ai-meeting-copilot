import type { AudioSourceKind, DisplaySourceInfo } from '../../../../shared/capture'
import {
  captureAudioLevelStore,
  useAudioLevel,
  type AudioLevelSnapshot,
  type AudioLevelStore
} from '../../audio/audioLevelStore'
import type { CaptureDisplayState } from './TranscriptPanel'
import { StealthSelect } from '../../components/StealthSelect'

export type SpeechProvider = 'auto' | 'deepgram' | 'sarvam'

export function screenToggleDisabled(
  captureState: CaptureDisplayState,
  screenEnabled: boolean,
  screenAcquiring: boolean
): boolean {
  return (
    captureState === 'starting' ||
    captureState === 'finalizing' ||
    (screenAcquiring && !screenEnabled)
  )
}

export function screenSourceControlsDisabled(
  captureState: CaptureDisplayState,
  loadingDisplaySources: boolean,
  screenAcquiring: boolean
): boolean {
  return (
    captureState === 'starting' ||
    captureState === 'finalizing' ||
    loadingDisplaySources ||
    screenAcquiring
  )
}

function Meter({
  kind,
  label,
  levelStore,
  fallbackLevel,
  seconds,
  active
}: {
  kind: AudioSourceKind
  label: string
  levelStore?: AudioLevelStore
  fallbackLevel: number
  seconds: number
  active: boolean
}) {
  // The compatibility path keeps existing callers working until OverlayView
  // moves level writes out of component state. With a stable levelStore prop,
  // only this Meter re-renders when its source changes.
  const storedLevel = useAudioLevel(levelStore ?? captureAudioLevelStore, kind)
  const level = levelStore ? storedLevel : fallbackLevel
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
  levels = { system: 0, mic: 0 },
  levelStore,
  seconds,
  displaySources,
  selectedDisplaySourceId,
  loadingDisplaySources,
  screenAcquiring,
  screenError,
  screenReady,
  lastScreenSentAt,
  hasGeneratedSummary,
  generatingMinutes,
  onStartOrPause,
  onNewSession,
  onGenerateMinutes,
  onToggleMic,
  onToggleScreen,
  onProviderChange,
  onSelectDisplaySource,
  onRefreshDisplaySources,
  collapsed,
  onToggleCollapsed
}: {
  captureState: CaptureDisplayState
  transcriptLineCount: number
  hasSessionContent: boolean
  isMeeting: boolean
  micEnabled: boolean
  screenEnabled: boolean
  provider: SpeechProvider
  audioError: string | null
  /** @deprecated Pass a stable levelStore to isolate high-frequency meter renders. */
  levels?: AudioLevelSnapshot
  levelStore?: AudioLevelStore
  seconds: { system: number; mic: number }
  displaySources: DisplaySourceInfo[]
  selectedDisplaySourceId: string
  loadingDisplaySources: boolean
  screenAcquiring: boolean
  screenError: string | null
  screenReady: boolean
  lastScreenSentAt: number | null
  hasGeneratedSummary: boolean
  generatingMinutes: boolean
  onStartOrPause: () => void
  onNewSession: () => void
  onGenerateMinutes: () => void
  onToggleMic: () => void
  onToggleScreen: () => void
  onProviderChange: (provider: SpeechProvider) => void
  onSelectDisplaySource: (id: string) => void
  onRefreshDisplaySources: () => void
  /** Folds the provider picker, meters and screen picker away — never the buttons. */
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const capturing = captureState === 'active'
  const captureBusy = captureState !== 'idle'
  const selectedDisplay = displaySources.find((source) => source.id === selectedDisplaySourceId)
  const sourceControlsDisabled = screenSourceControlsDisabled(
    captureState,
    loadingDisplaySources,
    screenAcquiring
  )

  return (
    <div
      className={`no-drag mx-3 shrink-0 rounded-xl border border-white/10 bg-black/20 ${
        collapsed ? 'mb-1.5 p-1.5' : 'mb-2 p-2.5'
      }`}
    >
      <div className={`flex flex-wrap items-center gap-2 ${collapsed ? '' : 'mb-2'}`}>
        <button
          type="button"
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
          type="button"
          onClick={onNewSession}
          disabled={captureState === 'finalizing' || !hasSessionContent}
          title="Clear the transcript, AI memory, summaries, participant names, minutes, and all session counters"
          className="rounded-md bg-white/5 px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 disabled:opacity-30"
        >
          New session
        </button>
        <button
          type="button"
          onClick={onGenerateMinutes}
          disabled={
            captureState === 'starting' || captureState === 'finalizing' || generatingMinutes
          }
          title={isMeeting ? 'End the meeting and generate minutes' : 'End the interview and generate a recap'}
          className="rounded-md bg-amber-500/90 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-400 disabled:opacity-40"
        >
          {captureBusy
            ? isMeeting ? 'End & Minutes' : 'End & Recap'
            : hasGeneratedSummary
              ? isMeeting ? 'View minutes' : 'View recap'
              : isMeeting ? 'Create minutes' : 'Create recap'}
        </button>
        <button
          type="button"
          onClick={onToggleMic}
          disabled={captureState === 'starting' || captureState === 'finalizing'}
          aria-pressed={micEnabled}
          title={
            micEnabled
              ? 'Your voice is included in the transcript.'
              : isMeeting
                ? 'Your voice is not recorded and will be missing from the minutes.'
                : 'Your voice is not recorded.'
          }
          className={`rounded-md px-2 py-1 text-xs ${
            micEnabled ? 'bg-white/15 text-zinc-100' : 'bg-white/5 text-zinc-500'
          } disabled:opacity-50`}
        >
          Mic {micEnabled ? 'on' : 'off'}
        </button>
        <button
          type="button"
          onClick={onToggleScreen}
          disabled={screenToggleDisabled(captureState, screenEnabled, screenAcquiring)}
          aria-pressed={screenEnabled}
          title="Opt in to screen context, before or during a session. Choose a display below; one JPEG is sent only when you request screen-aware AI."
          className={`rounded-md px-2 py-1 text-xs ${
            screenEnabled ? 'bg-cyan-400/15 text-cyan-200' : 'bg-white/5 text-zinc-500'
          } disabled:opacity-50`}
        >
          Screen {screenEnabled ? 'on' : 'off'}
        </button>
        {!collapsed && (
          <StealthSelect<SpeechProvider>
            label="Speech-to-text provider"
            value={provider}
            onChange={onProviderChange}
            disabled={captureBusy}
            title="Auto uses Sarvam first and falls back to Deepgram. Choose Deepgram directly for diarized speaker labels."
            options={[
              { value: 'auto', label: 'Auto (Sarvam + fallback)' },
              { value: 'sarvam', label: 'Sarvam · Indian English' },
              { value: 'deepgram', label: 'Deepgram · English + labels' }
            ]}
          />
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls="capture-controls-details"
          aria-label={collapsed ? 'Show capture details' : 'Hide capture details'}
          title={
            collapsed
              ? 'Show the provider, level meters and screen picker'
              : 'Hide the provider, level meters and screen picker to give the answer more room'
          }
          className="ml-auto rounded-md bg-white/5 px-1.5 py-1 text-[10px] font-medium text-zinc-400 hover:bg-white/10 hover:text-zinc-200"
        >
          {collapsed ? 'More ▸' : 'Less ▾'}
        </button>
        {audioError && (
          <span role="alert" className="basis-full text-[10px] text-red-300" title={audioError}>
            {audioError}
          </span>
        )}
      </div>

      {!collapsed && (
      <div id="capture-controls-details" className="contents">
      <div className="flex items-center gap-3">
        <Meter
          kind="system"
          label={isMeeting ? 'Meeting (system)' : 'Interviewer (system)'}
          levelStore={levelStore}
          fallbackLevel={levels.system}
          seconds={seconds.system}
          active={capturing}
        />
        {micEnabled && (
          <Meter
            kind="mic"
            label="You (mic)"
            levelStore={levelStore}
            fallbackLevel={levels.mic}
            seconds={seconds.mic}
            active={capturing}
          />
        )}
      </div>

      {isMeeting && !micEnabled && (
        <p className="mt-1.5 text-[10px] text-amber-300/90">
          Mic is off: your side of the conversation will not appear in the transcript or minutes.
        </p>
      )}

      {screenEnabled && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
          {selectedDisplay?.thumbnailDataUrl && captureState === 'idle' && (
            <img
              src={selectedDisplay.thumbnailDataUrl}
              alt={`Preview of ${selectedDisplay.name}`}
              className="h-12 w-20 rounded border border-white/15 bg-black object-cover"
            />
          )}
          <StealthSelect
            label="Screen source"
            value={selectedDisplaySourceId}
            onChange={onSelectDisplaySource}
            disabled={sourceControlsDisabled || displaySources.length === 0}
            options={
              displaySources.length === 0
                ? [{ value: '', label: 'No screen sources' }]
                : displaySources.map((source) => ({
                    value: source.id,
                    label: `${source.name}${source.isPrimary ? ' (primary)' : ''}`
                  }))
            }
            className="max-w-64 py-0.5 text-[10px] text-cyan-100"
          />
          <button
            type="button"
            onClick={onRefreshDisplaySources}
            disabled={sourceControlsDisabled}
            className="rounded bg-white/5 px-1.5 py-0.5 text-zinc-300 hover:bg-white/10 disabled:opacity-50"
          >
            {loadingDisplaySources ? 'Refreshing…' : 'Refresh screens'}
          </button>
          <span role={screenError ? 'alert' : 'status'} className={screenError ? 'text-amber-300' : 'text-cyan-300'}>
            {selectedDisplay?.isLikelyBlank && captureState === 'idle'
              ? 'This display preview looks blank. Choose another display or check Windows capture permissions.'
              : screenError
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
      )}
    </div>
  )
}
