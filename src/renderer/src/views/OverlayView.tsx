import { useEffect, useRef, useState } from 'react'
import type { SessionConfig, SessionMode } from '../App'
import { AudioCapture, type AudioSourceKind } from '../audio/AudioCapture'
import { captureAudioLevelStore } from '../audio/audioLevelStore'
import { ConfirmDialog } from '../components/ConfirmDialog'
import type { AiIntent, AiTextMessage, ScreenshotContext } from '../../../shared/ai'
import type { DisplaySourceInfo } from '../../../shared/capture'
import {
  createProgressiveAnswerPlan,
  isSameInterviewAnswer,
  type InterviewAnswerReason,
  type InterviewAnswerRequest,
  type InterviewAnswerStyle,
  type InterviewPinnedAnswerChange,
  type PinnedInterviewAnswer
} from '../../../shared/interviewAnswer'
import { createMinutesChunkPlan, formatMinutesPartials } from '../../../shared/minutesChunking'
import SettingsPanel from './SettingsPanel'
import {
  buildInterviewSystemPrompt as createInterviewSystemPrompt,
  buildMeetingSystemPrompt as createMeetingSystemPrompt,
  buildMinutesPrompt as createMinutesPrompt,
  buildSpeechKeyterms,
  buildSummarizerPrompt as createSummarizerPrompt
} from './overlay/prompts'
import {
  createSessionTrackingState,
  deleteTranscriptEntry,
  editTranscriptEntry,
  formatTranscript,
  formatTranscriptExport,
  mergeTranscriptForMinutes,
  sealTranscriptSourceForReconnect,
  shouldMarkAiRangeHandled,
  transcriptExportFilename,
  type PendingHandledRange,
  type TranscriptEntry,
  type TranscriptInterim,
  type TranscriptSource
} from './overlay/session'
import {
  TranscriptPanel,
  type CaptureDisplayState
} from './overlay/TranscriptPanel'
import { CaptureControls, type SpeechProvider } from './overlay/CaptureControls'
import { MinutesModal } from './overlay/MinutesModal'
import {
  ScreenPreviewModal,
  type ScreenPreview
} from './overlay/ScreenPreviewModal'
import { SessionHealthBar } from './overlay/SessionHealthBar'
import {
  AiWorkspace,
  type AiWorkspaceIntent,
  type AiWorkspaceTab
} from './overlay/AiWorkspace'
import {
  createAiTokenRenderBatcher,
  type AiTokenRenderBatcher
} from './overlay/aiTokenBatcher'
import {
  createAiAskRequest,
  createAiRequestId,
  isDirectedAtMe,
  looksLikeQuestion,
  selectLatestQuestion
} from './overlay/aiOrchestration'
import { isLikelyTranscriptNoise } from './overlay/transcriptSafety'
import { hasAiConfiguration, hasSpeechConfiguration } from './overlay/uiState'
import {
  isFocusMode,
  readOverlayPanelState,
  toggleFocusMode,
  togglePanel,
  writeOverlayPanelState,
  type OverlayPanelKey,
  type OverlayPanelState
} from './overlay/layoutPreferences'

// --- Voice-activity gate ----------------------------------------------------
// ASR models invent text during silence. We only accept a transcript when real
// speech-level audio energy occurred on its source within this window (the
// window covers the model's finalisation latency).
const VOICE_WINDOW_MS = 1800
// Sarvam runs its OWN server-side voice-activity detection and finalises an
// utterance in a batch shortly AFTER the speaker pauses — often after the strict
// window above has lapsed. Sarvam therefore gets a much wider window so its valid
// finals aren't wrongly dropped as "silence hallucinations" (it barely
// hallucinates over true silence, unlike Whisper/Deepgram-style engines).
const SARVAM_VOICE_WINDOW_MS = 6000
// Speech must exceed the adaptive noise floor and this hard-minimum RMS.
const SPEECH_RMS_MIN = 0.012
const SPEECH_FLOOR_MULT = 3
// Deepgram gives a per-utterance confidence (0-1). Real speech is typically
// > 0.6; only clearly low-confidence guesses (< this) are dropped so we keep
// correct-but-borderline words instead of losing them (accuracy over caution).
// (Sarvam sends no confidence, so its finals are undefined and skip this check.)
const MIN_CONFIDENCE = 0.45
// When people talk non-stop (e.g. two speakers overlapping), Deepgram never sees
// the silence it needs to finalise, so the live preview would sit there growing
// and never commit — it "waits for silence". If a preview keeps growing this long
// without a final, we promote it to a committed line right away so the transcript
// keeps moving. Deepgram's real final later replaces that line in place (no
// duplicate). Keep this short for an "immediate" feel.
const INTERIM_PROMOTE_MS = 1500

// --- Meeting auto-response timing -------------------------------------------
// Meeting mode fires the AI on a natural pause (debounce), but during a fast
// multi-speaker back-and-forth those pauses are rare, so a hard cap forces a
// timely response even while people keep talking.
// Pause after the last line before we treat the turn as over (general case).
const AUTO_SILENCE_MS = 1100
// Shorter wait when a question was clearly directed at me — respond faster.
const AUTO_DIRECTED_MS = 700
// Hard cap: once a burst starts, respond within this long no matter how
// continuously Speaker 1 and Speaker 2 keep talking.
const AUTO_MAX_WAIT_MS = 3800

// --- Long-meeting memory ----------------------------------------------------
// A meeting can run up to ~2 hours, far more transcript than fits in one model
// request. We keep a rolling summary of everything already discussed and only
// send that summary plus the newest verbatim lines. Once this many un-summarised
// finals build up (beyond the recent window kept verbatim), we fold them into
// the running summary in the background.
const SUMMARY_TRIGGER = 18
// Most-recent finals always kept verbatim (never folded into the summary yet),
// so the latest exchange stays exact for the AI.
const SUMMARY_KEEP_RECENT = 12

function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export default function OverlayView({
  config,
  onBack
}: {
  config: SessionConfig | null
  onBack: () => void
}) {
  const [settingsStatus, setSettingsStatus] = useState<Awaited<ReturnType<typeof window.api.getSettings>> | null>(null)
  const [shortcutHealth, setShortcutHealth] = useState<Awaited<ReturnType<typeof window.api.getShortcutHealth>> | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // Which secondary panels are folded away. Persisted so the layout you set up for
  // an interview is still there the next time you open the overlay.
  const [panels, setPanels] = useState<OverlayPanelState>(() => readOverlayPanelState())
  function updatePanels(next: OverlayPanelState): void {
    setPanels(next)
    writeOverlayPanelState(next)
  }
  const collapsePanel = (key: OverlayPanelKey): void => updatePanels(togglePanel(panels, key))
  const focused = isFocusMode(panels)
  const [confirmAction, setConfirmAction] = useState<'setup' | 'new' | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [finals, setFinals] = useState<TranscriptEntry[]>([])
  const [interim, setInterim] = useState<TranscriptInterim>({
    interviewer: '',
    you: ''
  })
  const [statusBySource, setStatusBySource] = useState<Record<TranscriptSource, string>>({
    interviewer: '',
    you: ''
  })
  const [suggestion, setSuggestion] = useState<string>('')
  // Completed past answers, kept on screen so a new response never wipes what
  // you're still reading. New answers append below these; the Clear button empties them.
  const [answerHistory, setAnswerHistory] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiNotice, setAiNotice] = useState<string | null>(null)
  const [autoAnswer, setAutoAnswer] = useState(true)
  const [manualQuestion, setManualQuestion] = useState('')
  const [currentQuestion, setCurrentQuestion] = useState('')
  const [answerStyle, setAnswerStyle] = useState<InterviewAnswerStyle>('standard')
  const answerStyleRef = useRef<InterviewAnswerStyle>('standard')
  const [currentAnswerStyle, setCurrentAnswerStyle] = useState<InterviewAnswerStyle>('standard')
  const [pinnedAnswers, setPinnedAnswers] = useState<PinnedInterviewAnswer[]>([])
  const pinnedAnswerSequenceRef = useRef(0)

  const captureRef = useRef<AudioCapture | null>(null)
  const micStartPromiseRef = useRef<Promise<void> | null>(null)
  const micStopPromiseRef = useRef<Promise<void> | null>(null)
  const [captureState, setCaptureState] = useState<CaptureDisplayState>('idle')
  const captureStateRef = useRef<CaptureDisplayState>('idle')
  const captureAttemptRef = useRef(0)
  const capturing = captureState === 'active'
  const captureBusy = captureState !== 'idle'

  function updateCaptureState(next: CaptureDisplayState): void {
    captureStateRef.current = next
    setCaptureState(next)
  }
  // Meetings need both sides for accurate minutes. Interviews keep the mic off
  // initially so the candidate can opt in to recording their own voice.
  const [micEnabled, setMicEnabled] = useState(config?.mode !== 'interview')
  const [stealth, setStealth] = useState(true)
  const [seconds, setSeconds] = useState<{ system: number; mic: number }>({ system: 0, mic: 0 })
  const [audioError, setAudioError] = useState<string | null>(null)
  // Screen-aware mode keeps the display video track locally and sends one
  // compressed frame only when an AI answer/analysis request is made.
  const [screenEnabled, setScreenEnabled] = useState(false)
  const [screenReady, setScreenReady] = useState(false)
  const [screenError, setScreenError] = useState<string | null>(null)
  const [screenPreview, setScreenPreview] = useState<ScreenPreview | null>(null)
  const [screenLikelyBlank, setScreenLikelyBlank] = useState(false)
  const [lastScreenSentAt, setLastScreenSentAt] = useState<number | null>(null)
  const [displaySources, setDisplaySources] = useState<DisplaySourceInfo[]>([])
  const [selectedDisplaySourceId, setSelectedDisplaySourceId] = useState('')
  const selectedDisplaySourceIdRef = useRef('')
  const [loadingDisplaySources, setLoadingDisplaySources] = useState(false)
  const screenEnabledRef = useRef(screenEnabled)
  const screenReadyRef = useRef(screenReady)
  // Serializes live screen acquisition so a double-click cannot leave two display
  // streams attached (or tear down the one that just succeeded).
  const screenBusyRef = useRef(false)
  useEffect(() => {
    screenEnabledRef.current = screenEnabled
  }, [screenEnabled])
  useEffect(() => {
    screenReadyRef.current = screenReady
  }, [screenReady])

  // ----- Meeting mode -----
  const mode: SessionMode = config?.mode ?? 'interview'
  const isConsultant = mode === 'consultant'
  const isMeeting = mode !== 'interview'
  // Auto follows the Settings contract: Sarvam first, Deepgram fallback.
  const [provider, setProvider] = useState<SpeechProvider>('auto')
  const [analysis, setAnalysis] = useState('')
  // Completed past analyses, kept on screen (same reasoning as answerHistory).
  const [analysisHistory, setAnalysisHistory] = useState<string[]>([])
  const [consultant, setConsultant] = useState('')
  const [consultantHistory, setConsultantHistory] = useState<string[]>([])
  const [autoAnalyze, setAutoAnalyze] = useState(mode === 'meeting')
  const [activeTab, setActiveTab] = useState<AiWorkspaceTab>(
    isConsultant ? 'consultant' : isMeeting ? 'analysis' : 'answer'
  )
  // Which kind of AI request is currently streaming, so tokens land in the right
  // pane (the main process only runs one stream at a time).
  const [activeIntent, setActiveIntent] = useState<AiWorkspaceIntent>('answer')
  const intentRef = useRef<AiWorkspaceIntent>('answer')
  const activeAiRequestIdRef = useRef<string | null>(null)
  const activeHandledRangeRef = useRef<PendingHandledRange | null>(null)
  const activeAiSessionRef = useRef(0)
  const aiRequestSequenceRef = useRef(0)
  const analysisAccRef = useRef('')
  const consultantAccRef = useRef('')
  // Minutes of Meeting: generated on demand when the meeting is ended, from the
  // full transcript. Shown in a modal overlay so it never disrupts the live UI.
  const [minutes, setMinutes] = useState('')
  const [minutesOpen, setMinutesOpen] = useState(false)
  const [minutesError, setMinutesError] = useState<string | null>(null)
  const [minutesPreparing, setMinutesPreparing] = useState(false)
  const [minutesNotice, setMinutesNotice] = useState<string | null>(null)
  const minutesTailNoticeRef = useRef<string | null>(null)
  const [minutesCopied, setMinutesCopied] = useState(false)
  const minutesAccRef = useRef('')
  const [minutesStage, setMinutesStage] = useState<'idle' | 'summarizing' | 'generating'>('idle')
  const minutesPipelineRef = useRef<{
    chunks: string[]
    partials: string[]
    index: number
    round: number
    chunkAccumulator: string
  } | null>(null)
  const minutesGenerationActiveRef = useRef(false)
  const minutesPreviousRef = useRef('')
  const minutesRunRef = useRef(0)
  const autoAnalyzeRef = useRef(autoAnalyze)
  const lastAnalyzedCountRef = useRef(0)
  // How many transcript lines had been produced the last time we answered a
  // question. Interviewer lines AFTER this point are the current, unanswered
  // question — so we never re-answer a question from an earlier turn (the mic is
  // off, so old and new questions aren't separated by a "Me:" line).
  const lastAnsweredCountRef = useRef(0)
  useEffect(() => {
    autoAnalyzeRef.current = autoAnalyze
  }, [autoAnalyze])

  // Map each diarized speaker index to a real name the user types in. Used in
  // the transcript UI and in the transcript text handed to the AI.
  const [speakerNames, setSpeakerNames] = useState<Record<number, string>>({})
  const speakerNamesRef = useRef(speakerNames)
  useEffect(() => {
    speakerNamesRef.current = speakerNames
  }, [speakerNames])

  const finalsRef = useRef(finals)
  const autoAnswerRef = useRef(autoAnswer)
  const streamingRef = useRef(streaming)
  useEffect(() => {
    finalsRef.current = finals
  }, [finals])
  useEffect(() => {
    autoAnswerRef.current = autoAnswer
  }, [autoAnswer])
  useEffect(() => {
    streamingRef.current = streaming
  }, [streaming])

  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showAiNotice(message: string): void {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setAiNotice(message)
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null
      setAiNotice(null)
    }, 4500)
  }

  async function refreshSettingsStatus(): Promise<void> {
    try {
      setSettingsStatus(await window.api.getSettings())
    } catch {
      setSettingsStatus(null)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSettingsStatus(), 0)
    void window.api.getShortcutHealth().then(setShortcutHealth).catch(() => undefined)
    const off = window.api.onShortcutHealthChanged(setShortcutHealth)
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [])

  // Per-source voice-activity state for the hallucination gate: `floor` is an
  // adaptive ambient-noise floor and `lastVoiceTs` is when speech-level energy
  // was last seen, so a transcript over true silence can be dropped.
  const vadRef = useRef<Record<AudioSourceKind, { floor: number; lastVoiceTs: number }>>({
    system: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 },
    mic: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 }
  })
  const lastFinalTranscriptAtRef = useRef<Record<AudioSourceKind, number>>({
    system: 0,
    mic: 0
  })

  // --- Immediate-commit for non-stop / overlapping speech --------------------
  // Live copy of the interim previews so the promote timer can read the latest
  // text without a stale closure.
  const interimRef = useRef(interim)
  useEffect(() => {
    interimRef.current = interim
  }, [interim])

  function updateFinals(
    updater: TranscriptEntry[] | ((previous: TranscriptEntry[]) => TranscriptEntry[])
  ): void {
    setFinals((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater
      finalsRef.current = next
      return next
    })
  }

  function updateInterim(
    updater: TranscriptInterim | ((previous: TranscriptInterim) => TranscriptInterim)
  ): void {
    setInterim((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater
      interimRef.current = next
      return next
    })
  }

  function freezeCurrentSpeakerLabels(): boolean {
    const hasUnfrozenSpeakers = finalsRef.current.some(
      (line) => line.source === 'interviewer' && line.speaker != null && !line.speakerName
    )
    if (!hasUnfrozenSpeakers) return false

    const currentNames = speakerNamesRef.current
    const fallback = isMeeting ? 'Speaker' : 'Interviewer'
    updateFinals((previous) =>
      previous.map((line) => {
        if (line.source !== 'interviewer' || line.speaker == null || line.speakerName) return line
        return {
          ...line,
          speakerName:
            currentNames[line.speaker]?.trim() || `${fallback} ${line.speaker + 1}`
        }
      })
    )
    // The next ASR stream starts a fresh diarization index space.
    speakerNamesRef.current = {}
    setSpeakerNames({})
    return true
  }
  // Whether a source currently has a line that was committed early from a still-
  // growing preview (awaiting Deepgram's real final to replace it in place).
  const hasProvisionalRef = useRef<Record<TranscriptSource, boolean>>({
    interviewer: false,
    you: false
  })
  // One-shot timer per source that promotes a long-running preview to a committed
  // line (see INTERIM_PROMOTE_MS) so non-stop speech never waits for silence.
  const promoteTimerRef = useRef<Record<TranscriptSource, ReturnType<typeof setTimeout> | null>>({
    interviewer: null,
    you: null
  })

  // Auto-answer is turn-based: we treat a run of interviewer finals as ONE turn
  // and answer only after they've been silent long enough that a mid-sentence
  // pause ("what is the gap... in Python") can't be mistaken for the end. This
  // gives a single answer per question instead of one per fragment.
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hard cap for meeting mode: armed once when a burst of speech starts and NOT
  // reset by later lines, so a fast back-and-forth between Speaker 1 and Speaker
  // 2 (gaps shorter than the pause window) still triggers a timely response
  // instead of waiting for a real silence that may never come.
  const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const turnHasQuestionRef = useRef(false)
  const turnDirectedRef = useRef(false)
  const queuedInterviewQuestionRef = useRef(false)

  // Transcript events are accepted only while this renderer owns a live or
  // gracefully-finalizing capture. A new-session reset increments the session
  // generation and closes this gate so late events cannot repopulate cleared UI.
  const sessionGenerationRef = useRef(0)
  const acceptingTranscriptsRef = useRef(false)
  const lastTranscriptEventAtRef = useRef(0)

  // High-frequency audio meters and streamed AI tokens publish outside this
  // monolithic session component so they cannot re-render the whole overlay.
  const aiTokenBatcherRef = useRef<AiTokenRenderBatcher | null>(null)

  // Conversation memory: prior (question -> answer) turns so the model can
  // resolve follow-ups like "explain that code", "add error handling", or
  // "make it shorter" against ITS OWN previous answer (the transcript alone
  // never contains what the AI said).
  const historyRef = useRef<{ role: 'user' | 'assistant'; content: string }[]>([])
  const pendingUserRef = useRef<string | null>(null)
  const answerAccRef = useRef('')

  // Long-meeting memory: a running prose summary of everything discussed earlier,
  // plus how far into the finals it covers, so the AI keeps full context across a
  // 2-hour session without us resending the entire transcript. Older lines are
  // folded into `meetingSummaryRef` in the background; recent lines stay verbatim.
  const meetingSummaryRef = useRef('')
  const summarizedUptoRef = useRef(0)
  const summarizeTargetRef = useRef(0)
  const summaryAccRef = useRef('')

  function buildSystemPrompt(): string {
    if (isMeeting) return createMeetingSystemPrompt(config, isConsultant)
    return createInterviewSystemPrompt(config)
  }

  function recentTranscript(n: number): string {
    return formatTranscript(finalsRef.current.slice(-n), speakerNamesRef.current, isMeeting)
  }

  // The single most recent thing the OTHER side said — i.e. the actual question
  // to answer right now. We only want to answer THIS, using earlier lines as
  // context, so the AI stops re-answering previous questions. We take the
  // interviewer/speaker lines that appeared since our last answer (the current
  // unanswered turn), joined so a question split across a couple of finals stays
  // whole.
  function latestQuestion(): string {
    return selectLatestQuestion(
      finalsRef.current,
      lastAnsweredCountRef.current,
      config?.userName
    )
  }

  // Recent verbatim lines prefixed with the running summary of everything said
  // earlier, so the AI always has the full history of the meeting — not just the
  // last few sentences — even hours in.
  function transcriptWithHistory(n: number): string {
    const summary = meetingSummaryRef.current.trim()
    const recent = recentTranscript(n)
    if (!summary) return recent
    const label = isMeeting ? 'meeting' : 'conversation'
    return (
      `Summary of what was discussed earlier in this ${label} (context — do not repeat it back):\n` +
      `${summary}\n\n` +
      `Most recent exchange (verbatim, continues from the summary above):\n${recent}`
    )
  }

  // --- Rolling summariser (long-meeting memory) -----------------------------
  // Runs opportunistically while the stream is idle. It folds older transcript
  // lines into `meetingSummaryRef` so we keep full context without ever sending
  // the whole 2-hour transcript to the model.
  function summarizeRange(fromIdx: number, toIdx: number): void {
    const lines = finalsRef.current.slice(fromIdx, toIdx)
    if (lines.length === 0) return
    const text = formatTranscript(lines, speakerNamesRef.current, isMeeting)
    intentRef.current = 'summarize'
    setActiveIntent('summarize')
    summaryAccRef.current = ''
    summarizeTargetRef.current = toIdx
    setStreaming(true)
    streamingRef.current = true
    pendingUserRef.current = null
    dispatchAiRequest('summarize', [
      { role: 'system', content: createSummarizerPrompt() },
      {
        role: 'user',
        content:
          `Summary so far:\n${meetingSummaryRef.current.trim() || '(nothing summarised yet)'}\n\n` +
          `New transcript lines to fold in:\n${text}\n\nReturn the updated running summary.`
      }
    ])
  }

  // If enough un-summarised lines have piled up (beyond the recent window we keep
  // verbatim) and nothing else is streaming, fold them into the summary.
  function maybeSummarize(): void {
    if (streamingRef.current || minutesGenerationActiveRef.current) return
    const from = summarizedUptoRef.current
    const to = finalsRef.current.length - SUMMARY_KEEP_RECENT
    if (to - from < SUMMARY_TRIGGER) return
    summarizeRange(from, to)
  }

  function restoreMinutesAfterFailure(message: string): void {
    const previous = minutesPreviousRef.current
    const partial = minutesAccRef.current.trim()
    // A failed regeneration must never destroy the last successful recap. On a
    // first generation, keeping a partial response is more useful than erasing it.
    setMinutes(previous || partial)
    minutesAccRef.current = ''
    minutesPreviousRef.current = ''
    minutesGenerationActiveRef.current = false
    minutesPipelineRef.current = null
    setMinutesPreparing(false)
    setMinutesStage('idle')
    setMinutesNotice(minutesTailNoticeRef.current)
    setMinutesError(message)
  }


  // Safety net: if the backend goes silent (dropped stream / stall) the UI must
  // never stay locked in "streaming" — otherwise every guarded ask is blocked.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function clearWatchdog(): void {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }
  function armWatchdog(requestId: string, timeoutMs = 30000): void {
    clearWatchdog()
    watchdogRef.current = setTimeout(() => {
      if (activeAiRequestIdRef.current !== requestId) return
      window.api.aiCancel(requestId)
      aiTokenBatcherRef.current?.discard(requestId)
      activeAiRequestIdRef.current = null
      activeHandledRangeRef.current = null
      streamingRef.current = false
      setStreaming(false)
      const wasGeneratingMinutes = minutesGenerationActiveRef.current
      if (wasGeneratingMinutes) {
        minutesRunRef.current += 1
        restoreMinutesAfterFailure(
          minutesPipelineRef.current
            ? 'A long-transcript preparation step timed out. Try generating the recap again.'
            : 'No response from the AI (timed out). Try generating the recap again.'
        )
      } else if (intentRef.current !== 'summarize') {
        setAiError((prev) => prev ?? 'No response from the AI (timed out). Ask again.')
      }
      if (!wasGeneratingMinutes) retryQueuedInterviewQuestion()
    }, timeoutMs)
  }

  function captureScreenshot(): ScreenshotContext | undefined {
    if (!screenEnabledRef.current || !screenReadyRef.current) return undefined
    try {
      const frame = captureRef.current?.captureScreenFrame()
      if (!frame) {
        setScreenError('The current screen frame is not ready; sending transcript only.')
        return undefined
      }
      setScreenLikelyBlank(frame.likelyBlank)
      if (frame.likelyBlank) {
        setScreenError(
          'The current frame looks blank, so it was not sent. Test the preview or choose another display.'
        )
        return undefined
      }
      setScreenError(null)
      setLastScreenSentAt(frame.capturedAt)
      return {
        dataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.capturedAt,
        detail: 'high'
      }
    } catch (error) {
      setScreenReady(false)
      screenReadyRef.current = false
      setScreenError(
        `Could not capture the selected screen: ${(error as Error).message}. Sending transcript only.`
      )
      return undefined
    }
  }

  function testScreenPreview(): void {
    if (!screenEnabledRef.current || !screenReadyRef.current) {
      setScreenError('Start listening with Screen on before testing a preview.')
      return
    }
    try {
      const frame = captureRef.current?.captureScreenFrame()
      if (!frame) {
        setScreenError('No current frame is available. Re-select the display and resume listening.')
        return
      }
      setScreenLikelyBlank(frame.likelyBlank)
      setScreenError(
        frame.likelyBlank
          ? 'The local preview looks blank. Protected content or capture permissions may be blocking it.'
          : null
      )
      setScreenPreview(frame)
    } catch (error) {
      setScreenError(
        `Could not test the selected screen: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  function dispatchAiRequest(
    intent: AiIntent,
    messages: AiTextMessage[],
    includeScreen = false,
    handledRange: PendingHandledRange | null = null
  ): void {
    const requestId = createAiRequestId(
      sessionGenerationRef.current,
      ++aiRequestSequenceRef.current,
      intent
    )
    const screenshot =
      includeScreen && (intent === 'answer' || intent === 'analyze')
        ? captureScreenshot()
        : undefined
    const request = createAiAskRequest({ requestId, intent, messages, screenshot })
    activeAiRequestIdRef.current = requestId
    activeHandledRangeRef.current = handledRange
    activeAiSessionRef.current = sessionGenerationRef.current
    armWatchdog(requestId, request.screenshot ? 45000 : 30000)
    window.api.aiAsk(request)
  }

  function streamAnswer(
    user: string,
    includeScreen = screenEnabledRef.current,
    handledRange: PendingHandledRange | null = null
  ): void {
    // Minutes is a multi-request pipeline. Superseding one of its requests would
    // strand the pipeline in a permanent "generating" state.
    if (minutesGenerationActiveRef.current) return
    // Supersede any in-flight request so a new question is never blocked.
    if (streamingRef.current) {
      const obsoleteRequestId = activeAiRequestIdRef.current
      window.api.aiCancel(obsoleteRequestId ?? undefined)
      if (obsoleteRequestId) aiTokenBatcherRef.current?.discard(obsoleteRequestId)
    }
    intentRef.current = 'answer'
    setActiveIntent('answer')
    // Note: we do NOT switch the active tab here. Auto-answer fires on every
    // question, and force-switching kept yanking you between Answer/Analysis.
    // The tab only changes when YOU click Answer / press the hotkey.
    // Keep the previous answer on screen: move it into history instead of wiping
    // it, so a new answer never erases what you're still reading.
    const prev = answerAccRef.current.trim()
    if (prev) setAnswerHistory((h) => [...h, prev].slice(-30))
    setSuggestion('')
    setAiError(null)
    setAiNotice(null)
    setStreaming(true)
    streamingRef.current = true
    answerAccRef.current = ''
    pendingUserRef.current = user
    dispatchAiRequest(
      'answer',
      [
        { role: 'system', content: buildSystemPrompt() },
        ...historyRef.current,
        { role: 'user', content: user }
      ],
      includeScreen,
      handledRange
    )
  }

  function streamInterviewAnswer(
    question: string,
    user: string,
    style: InterviewAnswerStyle,
    handledRange: PendingHandledRange | null = null,
    reason: InterviewAnswerReason = 'answer'
  ): void {
    const plan = createProgressiveAnswerPlan(question, style, reason)
    setCurrentQuestion(question)
    setCurrentAnswerStyle(style)
    streamAnswer(
      `${user}\n\nINTERVIEW RESPONSE FORMAT (follow exactly):\n${plan.instruction}`,
      screenEnabledRef.current,
      handledRange
    )
  }

  function regenerateInterviewAnswer(request: InterviewAnswerRequest): void {
    if (isMeeting || minutesGenerationActiveRef.current) return
    setActiveTab('answer')
    const context = transcriptWithHistory(14)
    streamInterviewAnswer(
      request.question,
      `Interview transcript (context only — do not answer a different question):\n${context || '(none)'}\n\n` +
        `THE EXACT QUESTION TO ANSWER AGAIN:\n"${request.question}"\n\n` +
        'Regenerate the response for this exact question. Use the transcript only as background and do not substitute a newer or older question.',
      request.style,
      null,
      'regenerate'
    )
  }

  function changePinnedInterviewAnswer(change: InterviewPinnedAnswerChange): void {
    if (change.action === 'unpin') {
      setPinnedAnswers((answers) => answers.filter((answer) => answer.id !== change.id))
      return
    }
    setPinnedAnswers((answers) => {
      if (answers.some((answer) => isSameInterviewAnswer(answer, change.answer))) return answers
      const pinned: PinnedInterviewAnswer = {
        ...change.answer,
        id: `answer-${Date.now()}-${++pinnedAnswerSequenceRef.current}`
      }
      return [...answers, pinned].slice(-20)
    })
  }

  function changeInterviewAnswerStyle(style: InterviewAnswerStyle): void {
    answerStyleRef.current = style
    setAnswerStyle(style)
  }

  /**
   * Meeting mode: analyse the recent discussion (validate correctness, suggest
   * fixes, propose follow-up questions). Routed to the Analysis pane. Analysis
   * is stateless — it is not added to the answer conversation memory.
   */
  function streamAnalysis(
    user: string,
    includeScreen = false,
    handledRange: PendingHandledRange | null = null
  ): void {
    if (minutesGenerationActiveRef.current) return
    if (streamingRef.current) {
      const obsoleteRequestId = activeAiRequestIdRef.current
      window.api.aiCancel(obsoleteRequestId ?? undefined)
      if (obsoleteRequestId) aiTokenBatcherRef.current?.discard(obsoleteRequestId)
    }
    intentRef.current = 'analyze'
    setActiveIntent('analyze')
    // Note: we do NOT force the active tab to 'analysis' here. Auto-analysis runs
    // continuously, and force-switching kept yanking the user off the Answer tab
    // so generated answers were never seen. Manual "Analyse" switches the tab
    // itself (see analyzeDiscussion caller); auto-analysis updates silently.
    // Keep the previous analysis on screen: move it into history instead of
    // wiping it, so continuous auto-analysis never erases what you're reading.
    const prev = analysisAccRef.current.trim()
    if (prev) setAnalysisHistory((h) => [...h, prev].slice(-30))
    setAnalysis('')
    setAiError(null)
    setAiNotice(null)
    setStreaming(true)
    streamingRef.current = true
    analysisAccRef.current = ''
    pendingUserRef.current = null
    dispatchAiRequest(
      'analyze',
      [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: user }
      ],
      includeScreen,
      handledRange
    )
  }

  function streamConsultant(user: string, includeScreen = screenEnabledRef.current): void {
    if (minutesGenerationActiveRef.current) return
    if (streamingRef.current) {
      const obsoleteRequestId = activeAiRequestIdRef.current
      window.api.aiCancel(obsoleteRequestId ?? undefined)
      if (obsoleteRequestId) aiTokenBatcherRef.current?.discard(obsoleteRequestId)
    }
    intentRef.current = 'consultant'
    setActiveIntent('consultant')
    const prev = consultantAccRef.current.trim()
    if (prev) setConsultantHistory((h) => [...h, prev].slice(-30))
    setConsultant('')
    setAiError(null)
    setAiNotice(null)
    setStreaming(true)
    streamingRef.current = true
    consultantAccRef.current = ''
    pendingUserRef.current = null
    dispatchAiRequest('analyze', [
      { role: 'system', content: createMeetingSystemPrompt(config, true) },
      { role: 'user', content: `[CONSULTANT]\n${user}` }
    ], includeScreen)
  }

  // Manual "Clear" for the answer / analysis panes — the only thing that empties
  // them now (new responses append instead of wiping).
  function clearAnswers(): void {
    setAnswerHistory([])
    setSuggestion('')
    answerAccRef.current = ''
    historyRef.current = []
    pendingUserRef.current = null
    setAiError(null)
  }
  function clearAnalyses(): void {
    setAnalysisHistory([])
    setAnalysis('')
    analysisAccRef.current = ''
  }

  function analyzeDiscussion(includeScreen = false): void {
    if (finalsRef.current.length === 0) {
      showAiNotice('Nothing to analyse yet. Start listening or type a question below.')
      return
    }
    // Only the lines that are NEW since the last analysis are what we analyse now;
    // everything before is context. This stops the analysis from re-covering
    // previous points every time.
    const targetEnd = finalsRef.current.length
    const targetStart = Math.min(lastAnalyzedCountRef.current, Math.max(0, targetEnd - 1))
    const latest = formatTranscript(
      finalsRef.current.slice(targetStart, targetEnd),
      speakerNamesRef.current,
      isMeeting
    )
    const earlier = formatTranscript(
      finalsRef.current.slice(0, targetStart).slice(-16),
      speakerNamesRef.current,
      isMeeting
    )
    streamAnalysis(
      `[ANALYZE] Earlier discussion (context only — already covered, do NOT re-analyse):\n${earlier || '(none)'}\n\n` +
        `THE LATEST PART TO ANALYSE NOW (new since the last analysis):\n${latest}\n\n` +
        `Analyse ONLY this latest part using the ANALYZE format. Do not repeat analysis of the earlier context above.`,
      includeScreen,
      { kind: 'analysis', end: targetEnd }
    )
  }

  // Meeting mode trigger: runs when the pause debounce OR the hard cap fires.
  // Clears both timers, then answers (if a question was aimed at me) or analyses
  // the discussion. If a stream is already running we skip — the next line will
  // re-arm the timers, so nothing is lost.
  function fireMeetingAuto(): void {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (maxWaitTimerRef.current) {
      clearTimeout(maxWaitTimerRef.current)
      maxWaitTimerRef.current = null
    }
    if (minutesGenerationActiveRef.current) {
      turnDirectedRef.current = false
      return
    }
    const directed = turnDirectedRef.current
    turnDirectedRef.current = false
    if (directed && autoAnswerRef.current) {
      // A question aimed at me has priority: answer it even if analysis is
      // currently streaming (streamAnswer cancels the in-flight analysis first).
      // Previously we bailed out when a stream was busy, so directed questions
      // were silently dropped while auto-analyse hogged the single AI stream —
      // that was the "answer is not generating" bug.
      askAi()
    } else if (autoAnalyzeRef.current) {
      // Analysis is lower priority: don't interrupt an in-flight answer/analysis.
      if (streamingRef.current) return
      // Only analyse once there is enough fresh discussion to be worth it.
      if (finalsRef.current.length - lastAnalyzedCountRef.current >= 2) analyzeDiscussion()
    }
  }

  // `manual` marks a deliberate user action (Answer button / hotkey). Auto-answer
  // passes false so it can never switch your tab, and so a turn that turns out to
  // hold no question stays silent instead of accusing you of asking nothing.
  function askAi(
    manual = false,
    style: InterviewAnswerStyle = answerStyleRef.current
  ): void {
    if (minutesGenerationActiveRef.current) {
      if (manual) {
        setMinutesOpen(true)
        showAiNotice('Finish or stop recap generation before asking another question.')
      }
      return
    }
    if (finalsRef.current.length === 0) {
      if (!manual) return
      setActiveTab('answer')
      showAiNotice('No detected question yet. Type the question in the box and press Ask.')
      return
    }
    const question = latestQuestion()
    if (!question) {
      if (manual) {
        showAiNotice('No unanswered interviewer question was found. Type it below and press Ask.')
      }
      return
    }
    if (manual) setActiveTab('answer')
    const targetEnd = finalsRef.current.length
    if (isMeeting) {
      setCurrentQuestion(question)
      streamAnswer(
        `[ANSWER] Recent meeting discussion (context only — do NOT answer anything here):\n${transcriptWithHistory(14)}\n\n` +
          `THE QUESTION TO ANSWER NOW (the most recent thing directed at me):\n"${question}"\n\n` +
          `Answer ONLY this most recent question, in the first person, ready to say out loud. Ignore and do not re-answer any earlier questions — use the discussion above only as background if this question refers back to it.`,
        screenEnabledRef.current,
        { kind: 'answer', end: targetEnd }
      )
      return
    }
    streamInterviewAnswer(
      question,
      `Interview transcript (context only — do NOT answer anything here):\n${transcriptWithHistory(14)}\n\n` +
        `THE QUESTION TO ANSWER NOW (the interviewer's most recent question):\n"${question}"\n\n` +
      `Answer ONLY this most recent question thoroughly. Do not re-answer earlier questions; use the transcript above only as background if this question refers back to it.`,
      style,
      { kind: 'answer', end: targetEnd }
    )
  }

  function retryQueuedInterviewQuestion(): void {
    if (isMeeting || !queuedInterviewQuestionRef.current) return
    setTimeout(() => {
      if (isMeeting || !queuedInterviewQuestionRef.current) return
      // Another stream started in the meantime; ITS completion retries this, so
      // the question stays queued rather than being answered against a busy stream.
      if (streamingRef.current) return
      // Every other exit is terminal for this question. Disarm before returning,
      // otherwise the flag stays set and an unrelated later stream ending fires an
      // answer to a question from minutes ago.
      queuedInterviewQuestionRef.current = false
      if (minutesGenerationActiveRef.current || !autoAnswerRef.current) return
      if (finalsRef.current.length <= lastAnsweredCountRef.current) return
      askAi()
    }, 0)
  }

  function askManual(): void {
    if (minutesGenerationActiveRef.current) {
      setMinutesOpen(true)
      showAiNotice('Finish or stop recap generation before asking another question.')
      return
    }
    const q = manualQuestion.trim()
    if (!q) {
      showAiNotice('Type a question first, then press Ask.')
      return
    }
    if (isConsultant) {
      setCurrentQuestion(q)
      setActiveTab('consultant')
      streamConsultant(
        `Optum technical consulting request:\n"${q}"\n\nUse the current screen if available. Give actionable Java/Spring Boot/GraphQL guidance and include exact Insomnia click steps whenever API testing is involved.`,
        screenEnabledRef.current
      )
      setManualQuestion('')
      return
    }
    // Manual ask: this is a deliberate user action, so show the Answer tab.
    setActiveTab('answer')
    const targetEnd = finalsRef.current.length
    const ctx = transcriptWithHistory(8)
    const user = isMeeting
      ? (ctx ? `[ANSWER] Recent meeting discussion (context):\n${ctx}\n\n` : '[ANSWER] ') +
        `Answer this for me, in the first person, ready to say out loud:\n"${q}"`
      : (ctx ? `Recent conversation (context):\n${ctx}\n\n` : '') +
        `The interviewer asked:\n"${q}"\n\nGive me the best answer to say out loud.`
    if (isMeeting) {
      setCurrentQuestion(q)
      streamAnswer(user, screenEnabledRef.current, { kind: 'answer', end: targetEnd })
    } else {
      streamInterviewAnswer(q, user, answerStyleRef.current, { kind: 'answer', end: targetEnd })
    }
    setManualQuestion('')
  }
  function clearConsultant(): void {
    setConsultantHistory([])
    setConsultant('')
    consultantAccRef.current = ''
  }

  function consultScreen(): void {
    if (!screenEnabledRef.current || !screenReadyRef.current) {
      setScreenError('Switch Screen on and start listening to use screen context.')
      return
    }
    setActiveTab('consultant')
    streamConsultant(
      `Review the current screen and recent transcript as a senior Java/GraphQL architect. Detect whether this is a user story, coding problem, API/schema design, existing code, error, or architecture discussion. Break down exactly what must be built, include concrete GraphQL request/response payloads and consistent Java/Spring Boot code where applicable, and explain the reasoning and delivery steps.\n\nRecent discussion:\n${transcriptWithHistory(14) || '(No transcript yet; use the screen.)'}`,
      true
    )
  }

  function analyzeScreen(): void {
    if (!screenEnabledRef.current || !screenReadyRef.current) {
      setScreenError('Switch Screen on and start listening to use screen context.')
      return
    }
    if (isConsultant) {
      consultScreen()
    } else if (isMeeting) {
      setActiveTab('analysis')
      streamAnalysis(
        '[ANALYZE] Examine the attached current screen together with the latest meeting transcript. Explain what is visible, identify the important point, risk, error, or decision, and suggest the most useful contribution or next step.',
        true
      )
    } else {
      setActiveTab('answer')
      const screenTask = 'Explain the question or task shown on the current screen'
      streamInterviewAnswer(
        screenTask,
        'Examine the attached current screen together with the recent interview transcript. Identify the visible question, code, diagram, error, or task and give me the accurate response I should say or the solution I should explain.',
        answerStyleRef.current,
        // This consumes the current turn too; without it auto-answer immediately
        // re-answers the spoken question we just covered from the screen.
        { kind: 'answer', end: finalsRef.current.length }
      )
    }
  }

  function cancelAi(): void {
    const wasGeneratingMinutes = minutesGenerationActiveRef.current
    clearWatchdog()
    const cancelledRequestId = activeAiRequestIdRef.current
    window.api.aiCancel(cancelledRequestId ?? undefined)
    if (cancelledRequestId) aiTokenBatcherRef.current?.discard(cancelledRequestId)
    activeAiRequestIdRef.current = null
    activeHandledRangeRef.current = null
    setStreaming(false)
    streamingRef.current = false
    pendingUserRef.current = null
    queuedInterviewQuestionRef.current = false
    if (wasGeneratingMinutes) {
      minutesRunRef.current += 1
      const previous = minutesPreviousRef.current
      const partial = minutesAccRef.current.trim()
      setMinutes(previous || partial)
      minutesAccRef.current = ''
      minutesPreviousRef.current = ''
      minutesGenerationActiveRef.current = false
      minutesPipelineRef.current = null
      setMinutesPreparing(false)
      setMinutesStage('idle')
      setMinutesNotice('Generation stopped. You can regenerate when ready.')
    }
  }

  // --- Session recap / minutes ----------------------------------------------
  function requestFinalMinutes(source: string, summarized: boolean): void {
    intentRef.current = 'minutes'
    setActiveIntent('minutes')
    minutesAccRef.current = ''
    setMinutesStage('generating')
    setMinutesNotice(
      summarized
        ? `Transcript sections summarized · generating the final ${mode === 'interview' ? 'recap' : 'minutes'}…`
        : minutesTailNoticeRef.current
    )
    setStreaming(true)
    streamingRef.current = true
    pendingUserRef.current = null
    const recapKind = mode === 'interview' ? 'interview recap' : 'Minutes of Meeting'
    dispatchAiRequest('minutes', [
      { role: 'system', content: createMinutesPrompt(config) },
      {
        role: 'user',
        content: summarized
          ? `These ordered summaries cover the full ${mode === 'interview' ? 'interview' : 'meeting'} transcript. Preserve their factual order and generate the ${recapKind} now:\n\n${source}`
          : `Here is the full ${mode === 'interview' ? 'interview' : 'meeting'} transcript:\n\n${source}\n\nGenerate the ${recapKind} now, following the required format.`
      }
    ])
  }

  function requestMinutesSummaryChunk(): void {
    const pipeline = minutesPipelineRef.current
    if (!pipeline) return
    const chunk = pipeline.chunks[pipeline.index]
    pipeline.chunkAccumulator = ''
    intentRef.current = 'summarize'
    setActiveIntent('summarize')
    setMinutesStage('summarizing')
    setMinutesNotice(
      `Preparing a long transcript · pass ${pipeline.round}, section ${pipeline.index + 1} of ${pipeline.chunks.length}`
    )
    setStreaming(true)
    streamingRef.current = true
    pendingUserRef.current = null
    dispatchAiRequest('summarize', [
      {
        role: 'system',
        content:
          'Extract a dense, factual, ordered section summary for later session-recap generation. Preserve questions, answers, decisions, actions, owners, dates, examples, disagreements, gaps, and speaker attribution. Do not invent or evaluate. Output concise Markdown only.'
      },
      {
        role: 'user',
        content: `Section ${pipeline.index + 1} of ${pipeline.chunks.length}:\n\n${chunk}`
      }
    ])
  }

  function continueMinutesPipeline(output: string): void {
    const pipeline = minutesPipelineRef.current
    if (!pipeline) return
    if (!output.trim()) {
      restoreMinutesAfterFailure('A transcript section returned no summary. Try generating the recap again.')
      return
    }
    pipeline.partials.push(output.trim())
    pipeline.index += 1
    if (pipeline.index < pipeline.chunks.length) {
      requestMinutesSummaryChunk()
      return
    }

    const combined = formatMinutesPartials(pipeline.partials)
    const nextPlan = createMinutesChunkPlan(combined, { maxTokensPerChunk: 6_000 })
    if (nextPlan.requiresHierarchicalSummary) {
      minutesPipelineRef.current = {
        chunks: nextPlan.chunks.map((chunk) => chunk.text),
        partials: [],
        index: 0,
        round: pipeline.round + 1,
        chunkAccumulator: ''
      }
      requestMinutesSummaryChunk()
      return
    }

    minutesPipelineRef.current = null
    requestFinalMinutes(nextPlan.chunks[0]?.text || combined, true)
  }

  // Called by the "End & Minutes" button. Stops capture, then asks the LLM to
  // turn the entire transcript (every finalised line) into minutes, streamed
  // into the minutes modal.
  async function generateMinutes(): Promise<void> {
    if (minutesGenerationActiveRef.current) {
      setMinutesOpen(true)
      return
    }
    minutesGenerationActiveRef.current = true
    minutesPreviousRef.current = minutes
    minutesAccRef.current = ''
    const run = ++minutesRunRef.current
    queuedInterviewQuestionRef.current = false
    clearCaptureTimers()
    turnHasQuestionRef.current = false
    turnDirectedRef.current = false
    if (streamingRef.current) {
      clearWatchdog()
      const obsoleteRequestId = activeAiRequestIdRef.current
      window.api.aiCancel(obsoleteRequestId ?? undefined)
      if (obsoleteRequestId) aiTokenBatcherRef.current?.discard(obsoleteRequestId)
      activeAiRequestIdRef.current = null
      activeHandledRangeRef.current = null
      pendingUserRef.current = null
      streamingRef.current = false
      setStreaming(false)
    }
    setMinutesError(null)
    const willFinalizeCapture = captureStateRef.current !== 'idle'
    if (willFinalizeCapture) minutesTailNoticeRef.current = null
    setMinutesNotice(willFinalizeCapture ? null : minutesTailNoticeRef.current)
    setMinutesStage('idle')
    minutesPipelineRef.current = null
    setMinutesOpen(true)
    if (willFinalizeCapture) {
      setMinutesPreparing(true)
      if (captureStateRef.current === 'finalizing') {
        const settled = await waitForCaptureIdle()
        if (!settled) {
          setMinutesPreparing(false)
          restoreMinutesAfterFailure(
            'Audio finalization is still running. Wait a moment, then generate the recap again.'
          )
          return
        }
      } else {
        await pauseCapture()
      }
      setMinutesPreparing(false)
    }
    if (run !== minutesRunRef.current || !minutesGenerationActiveRef.current) return
    const snapshot = mergeTranscriptForMinutes(finalsRef.current, interimRef.current)
    if (snapshot.length === 0) {
      restoreMinutesAfterFailure('No transcript yet — start listening and capture the meeting first.')
      return
    }
    updateFinals(snapshot)
    updateInterim({ interviewer: '', you: '' })
    const full = formatTranscript(snapshot, speakerNamesRef.current, isMeeting)
    const plan = createMinutesChunkPlan(full, { maxTokensPerChunk: 6_000 })
    if (!plan.requiresHierarchicalSummary) {
      requestFinalMinutes(full, false)
      return
    }
    minutesPipelineRef.current = {
      chunks: plan.chunks.map((chunk) => chunk.text),
      partials: [],
      index: 0,
      round: 1,
      chunkAccumulator: ''
    }
    requestMinutesSummaryChunk()
  }

  async function copyMinutes(): Promise<void> {
    const text = minutesAccRef.current || minutes
    if (!text) return
    // Prefer Electron's main-process clipboard (reliable in an unfocused overlay);
    // fall back to the web Clipboard API if for some reason it's unavailable.
    let ok = false
    try {
      ok = await window.api.copyText(text)
    } catch {
      // Use the browser clipboard fallback below.
    }
    if (!ok) {
      try {
        await navigator.clipboard.writeText(text)
        ok = true
      } catch {
        return
      }
    }
    if (ok) {
      setMinutesCopied(true)
      setTimeout(() => setMinutesCopied(false), 1500)
    }
  }

  useEffect(() => {
    const off = window.api.onAudioStats((s) => setSeconds(s))
    return off
  }, [])

  useEffect(() => {
    const tokenBatcher = createAiTokenRenderBatcher(({ channel, text }) => {
      if (channel === 'answer') setSuggestion((previous) => previous + text)
      else if (channel === 'analysis') setAnalysis((previous) => previous + text)
      else if (channel === 'consultant') setConsultant((previous) => previous + text)
      else setMinutes(minutesAccRef.current)
    })
    aiTokenBatcherRef.current = tokenBatcher
    const offToken = window.api.onAiToken(({ requestId, text }) => {
      if (activeAiRequestIdRef.current !== requestId) return
      armWatchdog(requestId)
      if (intentRef.current === 'summarize' && minutesPipelineRef.current) {
        minutesPipelineRef.current.chunkAccumulator += text
      } else if (intentRef.current === 'summarize') {
        // Background memory update — accumulate silently, never touch the UI.
        summaryAccRef.current += text
      } else if (intentRef.current === 'minutes') {
        minutesAccRef.current += text
        tokenBatcher.enqueue(requestId, 'minutes', text)
      } else if (intentRef.current === 'analyze') {
        analysisAccRef.current += text
        tokenBatcher.enqueue(requestId, 'analysis', text)
      } else if (intentRef.current === 'consultant') {
        consultantAccRef.current += text
        tokenBatcher.enqueue(requestId, 'consultant', text)
      } else {
        answerAccRef.current += text
        tokenBatcher.enqueue(requestId, 'answer', text)
      }
    })
    const offDone = window.api.onAiDone(({ requestId }) => {
      if (activeAiRequestIdRef.current !== requestId) return
      tokenBatcher.flush(requestId)
      const handledRange = activeHandledRangeRef.current
      const output =
        intentRef.current === 'summarize' && minutesPipelineRef.current
          ? minutesPipelineRef.current.chunkAccumulator
          : intentRef.current === 'answer'
          ? answerAccRef.current
          : intentRef.current === 'analyze'
            ? analysisAccRef.current
            : intentRef.current === 'consultant'
              ? consultantAccRef.current
              : intentRef.current === 'minutes'
                ? minutesAccRef.current
                : summaryAccRef.current
      if (
        handledRange &&
        activeAiSessionRef.current === sessionGenerationRef.current &&
        shouldMarkAiRangeHandled('done', output)
      ) {
        if (handledRange.kind === 'answer') {
          lastAnsweredCountRef.current = Math.max(lastAnsweredCountRef.current, handledRange.end)
        } else {
          lastAnalyzedCountRef.current = Math.max(lastAnalyzedCountRef.current, handledRange.end)
        }
      }
      activeAiRequestIdRef.current = null
      activeHandledRangeRef.current = null
      clearWatchdog()
      setStreaming(false)
      streamingRef.current = false
      if (intentRef.current === 'summarize' && minutesPipelineRef.current) {
        pendingUserRef.current = null
        continueMinutesPipeline(output)
        return
      }
      // Only answers become conversation memory; analysis is stateless.
      if (intentRef.current === 'summarize') {
        const s = summaryAccRef.current.trim()
        if (s) {
          meetingSummaryRef.current = s
          summarizedUptoRef.current = summarizeTargetRef.current
        }
        summaryAccRef.current = ''
      } else if (intentRef.current === 'minutes') {
        if (!minutesAccRef.current.trim()) {
          restoreMinutesAfterFailure('The AI returned an empty recap. Try generating it again.')
          pendingUserRef.current = null
          return
        }
        minutesGenerationActiveRef.current = false
        minutesPreviousRef.current = ''
        setMinutesStage('idle')
        setMinutesNotice(minutesTailNoticeRef.current)
      } else if (intentRef.current === 'answer') {
        const user = pendingUserRef.current
        const answer = answerAccRef.current.trim()
        if (user && answer) {
          historyRef.current.push(
            { role: 'user', content: user.slice(-700) },
            { role: 'assistant', content: answer.slice(-2000) }
          )
          if (historyRef.current.length > 8) {
            historyRef.current = historyRef.current.slice(-8)
          }
        }
      }
      pendingUserRef.current = null
      retryQueuedInterviewQuestion()
      // Now that the stream is idle, fold any backlog of older lines into memory.
      setTimeout(() => maybeSummarize(), 0)
    })
    const offErr = window.api.onAiError(({ requestId, message }) => {
      if (activeAiRequestIdRef.current !== requestId) return
      tokenBatcher.discard(requestId)
      activeAiRequestIdRef.current = null
      activeHandledRangeRef.current = null
      clearWatchdog()
      // A failed background summarise must stay silent — keep the old summary and
      // retry later rather than showing an error over the transcript.
      if (intentRef.current === 'summarize' && minutesPipelineRef.current) {
        setStreaming(false)
        streamingRef.current = false
        pendingUserRef.current = null
        restoreMinutesAfterFailure(message)
        return
      }
      if (intentRef.current === 'summarize') {
        setStreaming(false)
        streamingRef.current = false
        summaryAccRef.current = ''
        pendingUserRef.current = null
        retryQueuedInterviewQuestion()
        return
      }
      // A failed minutes generation is shown inside the minutes modal.
      if (intentRef.current === 'minutes') {
        setStreaming(false)
        streamingRef.current = false
        pendingUserRef.current = null
        restoreMinutesAfterFailure(message)
        return
      }
      setAiError(message)
      setStreaming(false)
      streamingRef.current = false
      pendingUserRef.current = null
      // Deliberately keep the accumulators. A cut-off or dropped response is
      // usually most of a usable answer, and clearing them here used to delete it
      // twice over: hidden behind the error banner now, and never moved into
      // history by the next question either.
      retryQueuedInterviewQuestion()
    })
    return () => {
      offToken()
      offDone()
      offErr()
      tokenBatcher.dispose()
      if (aiTokenBatcherRef.current === tokenBatcher) aiTokenBatcherRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Long-meeting memory: periodically fold older transcript into the running
  // summary while the stream is idle, so context survives a 2-hour session even
  // if the user turns auto-analyse/answer off.
  useEffect(() => {
    const id = setInterval(() => maybeSummarize(), 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const off = window.api.onStealthChanged(setStealth)
    return off
  }, [])

  useEffect(() => {
    // Updating the finalized snapshot for End & Recap must not trigger an
    // auto-answer that supersedes the recap's multi-request pipeline.
    if (minutesGenerationActiveRef.current) return
    const last = finals[finals.length - 1]
    if (!last || last.source !== 'interviewer') return

    if (isMeeting) {
      // Meeting mode runs off two independent toggles, so don't early-return on
      // autoAnswer. Track whether this turn should be ANSWERED (draft a reply for
      // me to say) vs just analysed. We answer when auto-answer is on and either
      // the utterance is clearly aimed at me (my name / "what do you think")
      // A general question between other participants belongs in analysis. Draft
      // an answer only for clear name/second-person cues aimed at this user.
      const directed = autoAnswerRef.current && isDirectedAtMe(last.text, config?.userName)
      if (directed) turnDirectedRef.current = true
      // Debounce: (re)arm the "they've stopped talking" pause timer. Use a
      // shorter wait when a question is aimed at me so I get an answer faster.
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
      const wait = turnDirectedRef.current ? AUTO_DIRECTED_MS : AUTO_SILENCE_MS
      autoTimerRef.current = setTimeout(fireMeetingAuto, wait)
      // Hard cap: arm ONCE at the start of a burst and never reset it, so a fast
      // Speaker 1 ↔ Speaker 2 exchange (no long pause) still fires in time.
      if (!maxWaitTimerRef.current) {
        maxWaitTimerRef.current = setTimeout(fireMeetingAuto, AUTO_MAX_WAIT_MS)
      }
      return
    }

    if (!autoAnswerRef.current) return
    // The interviewer is still in their turn. Remember if any fragment so far is
    // a question, then (re)arm the "they've stopped talking" timer. A short pause
    // inside a sentence must NOT end the turn, so the window is safely longer
    // than a natural one-second pause.
    // Match what selectLatestQuestion will accept, so a turn is never armed for a
    // prompt the selector rejects — or dropped for one it would have answered.
    if (looksLikeQuestion(last.text) || isDirectedAtMe(last.text, config?.userName)) {
      turnHasQuestionRef.current = true
    }
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = null
      const ask = turnHasQuestionRef.current
      turnHasQuestionRef.current = false // the turn is over either way
      if (!ask || !autoAnswerRef.current) return
      // Preserve a question that reaches the end of its turn while another
      // response is streaming. Completion/error will retry it against the latest
      // transcript instead of silently discarding it.
      if (streamingRef.current) {
        queuedInterviewQuestionRef.current = true
        return
      }
      askAi()
    }, AUTO_SILENCE_MS)
    // This effect intentionally reacts only to committed transcript changes;
    // helpers read current values from refs to avoid resetting its timers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finals])

  useEffect(() => {
    // Cancel a pending promote timer for a source.
    const clearPromote = (src: TranscriptSource): void => {
      const t = promoteTimerRef.current[src]
      if (t) {
        clearTimeout(t)
        promoteTimerRef.current[src] = null
      }
    }
    // Commit a preview that has run too long without finalising, so the
    // transcript keeps flowing during non-stop speech. Marked `provisional` so
    // Deepgram's real final can replace it in place instead of duplicating.
    const promote = (src: TranscriptSource): void => {
      promoteTimerRef.current[src] = null
      const t = interimRef.current[src]?.trim()
      if (!t || hasProvisionalRef.current[src]) return
      hasProvisionalRef.current[src] = true
      updateFinals((prev) => [
        ...prev,
        { source: src, text: t, timestampMs: Date.now(), provisional: true }
      ])
      updateInterim((prev) => ({ ...prev, [src]: '' }))
    }
    const offT = window.api.onTranscript(({ source, text, isFinal, speaker, confidence }) => {
      if (!acceptingTranscriptsRef.current) return
      lastTranscriptEventAtRef.current = Date.now()
      const kind: AudioSourceKind = source === 'interviewer' ? 'system' : 'mic'
      // Sarvam sends no confidence (its finals are undefined) and does its own
      // server-side VAD, so it needs a wider local window; confidence-bearing
      // engines (Deepgram) keep the strict window to catch their hallucinations.
      const serverVad = typeof confidence !== 'number'
      const voiceWindow = serverVad ? SARVAM_VOICE_WINDOW_MS : VOICE_WINDOW_MS
      // Voice-activity gate: if no speech-level audio energy occurred on this
      // source recently, the model invented this text over silence — ignore it.
      const heardVoice = Date.now() - vadRef.current[kind].lastVoiceTs <= voiceWindow
      // Deepgram's per-utterance confidence (0-1). High = trust its own VAD.
      const conf = typeof confidence === 'number' ? confidence : undefined
      const lowConfidence = conf !== undefined && conf < MIN_CONFIDENCE
      if (isFinal) {
        lastFinalTranscriptAtRef.current[kind] = Date.now()
        // A final ends the current utterance, so cancel any pending promote timer.
        clearPromote(source)
        // Decide whether to keep this finalised line.
        //  - Deepgram (has a confidence): TRUST its professional VAD + confidence.
        //    Drop only obvious hallucination phrases (isNoise) or genuinely
        //    low-confidence guesses. We deliberately do NOT require our crude RMS
        //    energy meter here: on system/loopback audio it often under-reads and
        //    was silently dropping correct medium-confidence words — the main
        //    cause of the "accuracy is too low / words missing" problem.
        //  - Sarvam (no confidence): fall back to the RMS voice window to reject
        //    text invented over true silence.
        const isBad =
          isLikelyTranscriptNoise(text) || (conf !== undefined ? lowConfidence : !heardVoice)
        if (isBad) {
          if (!isLikelyTranscriptNoise(text) && !heardVoice)
            console.debug('[vad] dropped silent hallucination:', text)
          if (!isLikelyTranscriptNoise(text) && lowConfidence)
            console.debug('[conf] dropped low-confidence text:', conf, text)
          // If a provisional line already showed this (real) speech, keep it as a
          // committed line rather than erasing it; only clear the gray preview.
          if (hasProvisionalRef.current[source]) {
            hasProvisionalRef.current[source] = false
            updateFinals((prev) =>
              prev.map((l) =>
                l.provisional && l.source === source ? { ...l, provisional: false } : l
              )
            )
          }
          updateInterim((prev) => ({ ...prev, [source]: '' }))
          return
        }
        // Accepted final: if we committed this utterance early, replace that
        // provisional line in place (now with the accurate text + speaker label);
        // otherwise append a new line. This is what prevents duplicates.
        updateFinals((prev) => {
          const idx = prev.findIndex((l) => l.provisional && l.source === source)
          if (idx !== -1) {
            const next = prev.slice()
            next[idx] = {
              source,
              text,
              speaker,
              timestampMs: next[idx].timestampMs ?? Date.now(),
              provisional: false
            }
            return next
          }
          return [...prev, { source, text, speaker, timestampMs: Date.now() }]
        })
        hasProvisionalRef.current[source] = false
        updateInterim((prev) => ({ ...prev, [source]: '' }))
      } else if (heardVoice || conf !== undefined) {
        // Live preview (interim). Deepgram sends a confidence with every partial
        // and its own professional VAD already decided this is speech — so show
        // partials immediately instead of waiting for our crude RMS meter.
        if (hasProvisionalRef.current[source]) {
          // This utterance was already committed early: keep refining that line
          // in place instead of showing a separate gray preview below it.
          updateFinals((prev) =>
            prev.map((l) => (l.provisional && l.source === source ? { ...l, text } : l))
          )
        } else {
          updateInterim((prev) => ({ ...prev, [source]: text }))
          // Arm a one-shot timer (only when a fresh preview starts) so a preview
          // that never finalises — non-stop / overlapping speech — is committed
          // within INTERIM_PROMOTE_MS instead of waiting for a silence.
          if (!promoteTimerRef.current[source]) {
            promoteTimerRef.current[source] = setTimeout(() => promote(source), INTERIM_PROMOTE_MS)
          }
        }
      }
    })
    const offS = window.api.onTranscriptStatus(({ source, status, message, provider, attempt }) => {
      if (!acceptingTranscriptsRef.current && captureStateRef.current === 'idle') return
      if (status === 'reconnecting') {
        // Close the old socket's transcript epoch before accepting results from
        // the new one. Otherwise its first final can replace an old provisional
        // line and silently remove content from the transcript and recap.
        clearPromote(source)
        const oldInterim = interimRef.current[source]
        updateFinals((previous) =>
          sealTranscriptSourceForReconnect(previous, source, oldInterim)
        )
        hasProvisionalRef.current[source] = false
        updateInterim((previous) => ({ ...previous, [source]: '' }))
        if (source === 'interviewer' && freezeCurrentSpeakerLabels()) {
          showAiNotice('Speech reconnected. Confirm participant names again for the new speaker segment.')
        }
      }
      const providerLabel = provider === 'deepgram' ? 'Deepgram' : provider === 'sarvam' ? 'Sarvam' : ''
      const retryLabel = status === 'reconnecting' && attempt ? ` attempt ${attempt}` : ''
      setStatusBySource((previous) => ({
        ...previous,
        [source]: message
          ? `${status}: ${message}`
          : `${status}${providerLabel ? `: ${providerLabel}` : ''}${retryLabel}`
      }))
    })
    return () => {
      offT()
      offS()
      clearPromote('interviewer')
      clearPromote('you')
    }
    // Listener callbacks intentionally read the live transcript/name refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    window.api.getStealth().then(setStealth)
  }, [])

  function toggleStealth(): void {
    setStealth((prev) => {
      const next = !prev
      window.api.setStealth(next)
      return next
    })
  }

  useEffect(() => {
    return () => {
      captureAttemptRef.current += 1
      acceptingTranscriptsRef.current = false
      const capture = captureRef.current
      captureRef.current = null
      capture?.stop()
      window.api.audioStop()
      const aiRequestId = activeAiRequestIdRef.current
      activeAiRequestIdRef.current = null
      if (aiRequestId) window.api.aiCancel(aiRequestId)
      clearWatchdog()
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current)
      if (maxWaitTimerRef.current) clearTimeout(maxWaitTimerRef.current)
      captureAudioLevelStore.reset()
      aiTokenBatcherRef.current?.clear()
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  // Feed each level sample into the voice-activity tracker: the floor falls fast
  // toward quiet and rises slowly, so it follows the ambient baseline rather than
  // speech; energy clearly above it counts as a real voice.
  function registerLevel(kind: AudioSourceKind, level: number): void {
    const v = vadRef.current[kind]
    v.floor += (level - v.floor) * (level < v.floor ? 0.25 : 0.001)
    if (level > Math.max(SPEECH_RMS_MIN, v.floor * SPEECH_FLOOR_MULT)) {
      v.lastVoiceTs = Date.now()
    }
  }

  async function refreshDisplaySources(): Promise<DisplaySourceInfo[]> {
    setLoadingDisplaySources(true)
    try {
      const sources = await window.api.listDisplaySources()
      setDisplaySources(sources)
      const current = selectedDisplaySourceIdRef.current
      const selected = sources.some((source) => source.id === current)
        ? current
        : (sources.find((source) => source.isSelected)?.id ?? sources[0]?.id ?? '')
      selectedDisplaySourceIdRef.current = selected
      setSelectedDisplaySourceId(selected)
      setScreenLikelyBlank(Boolean(sources.find((source) => source.id === selected)?.isLikelyBlank))
      if (sources.length === 0) {
        setScreenError('No displays are available to capture. Check Windows screen-capture permissions.')
      }
      return sources
    } catch (error) {
      setScreenError(`Could not list screens: ${(error as Error).message}`)
      return []
    } finally {
      setLoadingDisplaySources(false)
    }
  }

  async function prepareDisplaySource(): Promise<boolean> {
    if (!screenEnabledRef.current) return true
    // Re-enumerate at each start so dock/monitor reconnects cannot leave a stale
    // source id that makes screen-aware capture silently fall back or fail.
    const sources = await refreshDisplaySources()
    const selected = sources.some((source) => source.id === selectedDisplaySourceIdRef.current)
      ? selectedDisplaySourceIdRef.current
      : sources[0]?.id
    if (!selected) {
      setScreenError('Choose a display before starting screen-aware capture.')
      return false
    }
    try {
      await window.api.selectDisplaySource(selected)
      selectedDisplaySourceIdRef.current = selected
      setSelectedDisplaySourceId(selected)
      return true
    } catch (error) {
      setScreenError(`Could not select that screen: ${(error as Error).message}`)
      return false
    }
  }

  function queueMeterLevel(kind: AudioSourceKind, level: number): void {
    captureAudioLevelStore.setLevel(kind, level)
  }

  /**
   * Attach (or re-attach) screen context to a session that is already listening.
   * The display stream is separate from the loopback-audio stream, so nothing here
   * interrupts the transcript.
   */
  async function acquireScreenContext(): Promise<void> {
    const capture = captureRef.current
    if (!capture || captureStateRef.current !== 'active' || !screenEnabledRef.current) return
    if (screenBusyRef.current) return
    screenBusyRef.current = true
    try {
      if (!(await prepareDisplaySource())) {
        setScreenReady(false)
        screenReadyRef.current = false
        return
      }
      const ready = await capture.startScreen()
      // The session may have been stopped, or screen switched back off, while the
      // picker was open. Don't leave an orphaned display stream running.
      if (
        captureRef.current !== capture ||
        captureStateRef.current !== 'active' ||
        !screenEnabledRef.current
      ) {
        capture.stopScreen()
        return
      }
      setScreenReady(ready)
      screenReadyRef.current = ready
      setLastScreenSentAt(null)
      setScreenError(null)
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      setScreenReady(false)
      screenReadyRef.current = false
      setScreenError(
        `Could not turn screen context on: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    } finally {
      screenBusyRef.current = false
    }
  }

  async function toggleScreenContext(): Promise<void> {
    if (screenBusyRef.current) return
    const next = !screenEnabledRef.current
    screenEnabledRef.current = next
    setScreenEnabled(next)
    setScreenError(null)
    setScreenLikelyBlank(false)
    setScreenPreview(null)

    if (!next) {
      captureRef.current?.stopScreen()
      setScreenReady(false)
      screenReadyRef.current = false
      setLastScreenSentAt(null)
      return
    }
    // Idle: only populate the picker — the stream is acquired when listening starts.
    if (captureStateRef.current !== 'active') {
      await refreshDisplaySources()
      return
    }
    await acquireScreenContext()
  }

  async function changeDisplaySource(id: string): Promise<void> {
    selectedDisplaySourceIdRef.current = id
    setSelectedDisplaySourceId(id)
    setScreenError(null)
    setScreenLikelyBlank(Boolean(displaySources.find((source) => source.id === id)?.isLikelyBlank))
    // Re-acquire so picking a different monitor mid-session takes effect now
    // instead of silently continuing to capture the previous one.
    if (captureStateRef.current === 'active' && screenEnabledRef.current) {
      await acquireScreenContext()
    }
  }

  async function startCapture(): Promise<void> {
    if (captureRef.current || captureStateRef.current !== 'idle') return
    // Every start creates a new diarization stream whose numeric speaker IDs may
    // refer to different people. Freeze old labels before accepting new lines.
    freezeCurrentSpeakerLabels()
    const attempt = ++captureAttemptRef.current
    updateCaptureState('starting')
    setAudioError(null)
    setScreenError(null)
    setScreenReady(false)
    setScreenLikelyBlank(false)
    screenReadyRef.current = false
    setLastScreenSentAt(null)
    setStatusBySource({ interviewer: 'connecting', you: micEnabled ? 'connecting' : 'stopped' })
    if (!(await prepareDisplaySource())) {
      updateCaptureState('idle')
      return
    }
    if (attempt !== captureAttemptRef.current) return
    acceptingTranscriptsRef.current = true
    lastTranscriptEventAtRef.current = 0
    hasProvisionalRef.current = { interviewer: false, you: false }
    if (promoteTimerRef.current.interviewer) clearTimeout(promoteTimerRef.current.interviewer)
    if (promoteTimerRef.current.you) clearTimeout(promoteTimerRef.current.you)
    promoteTimerRef.current = { interviewer: null, you: null }
    vadRef.current = {
      system: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 },
      mic: { floor: SPEECH_RMS_MIN, lastVoiceTs: 0 }
    }
    lastFinalTranscriptAtRef.current = { system: 0, mic: 0 }
    const capture = new AudioCapture({
      onLevel: (kind, level) => {
        registerLevel(kind, level)
        queueMeterLevel(kind, level)
      },
      onChunk: (kind, pcm) => window.api.sendAudioChunk(kind, pcm.buffer as ArrayBuffer),
      onError: (kind, err) => {
        if (kind === 'system' && /screen|display|video/i.test(err.message) && !/ended$/i.test(err.message)) {
          setScreenError(err.message)
        } else {
          setAudioError(`${kind === 'system' ? 'System audio' : 'Mic'}: ${err.message}`)
        }
        if (captureRef.current === capture && kind === 'system' && /ended$/i.test(err.message)) {
          void pauseCapture()
        } else if (kind === 'mic' && /ended$/i.test(err.message)) {
          void stopMicCaptureGracefully(capture)
        }
      }
    })
    captureRef.current = capture
    // Connect capture and ASR together. The provider buffers a short PCM tail
    // during its handshake, while the UI remains "Starting" until both succeed.
    const [speechOutcome, captureOutcome] = await Promise.allSettled([
      window.api.audioStart(
        false,
        provider,
        buildSpeechKeyterms(config, { meeting: isMeeting, consultant: isConsultant })
      ),
      capture.startSystem(screenEnabled)
    ])
    if (attempt !== captureAttemptRef.current) {
      capture.stop()
      return
    }

    const speechStart = speechOutcome.status === 'fulfilled' ? speechOutcome.value : null
    if (!speechStart?.ready || captureOutcome.status === 'rejected') {
      const providerReason = speechStart?.sources
        .filter((source) => source.state === 'error')
        .map((source) => source.message)
        .filter(Boolean)
        .join(' ')
      const captureReason =
        captureOutcome.status === 'rejected'
          ? captureOutcome.reason instanceof Error
            ? captureOutcome.reason.message
            : String(captureOutcome.reason)
          : ''
      const speechReason =
        speechOutcome.status === 'rejected'
          ? speechOutcome.reason instanceof Error
            ? speechOutcome.reason.message
            : String(speechOutcome.reason)
          : providerReason
      const message = captureReason || speechReason || 'The speech provider did not connect.'
      if (captureReason) {
        setAudioError(`System audio: ${captureReason}`)
        if (screenEnabledRef.current) {
          setScreenError(
            `Screen capture failed: ${captureReason}. Re-select the display; protected or DRM content may not be capturable.`
          )
        }
      } else {
        setAudioError(`Speech-to-text: ${message}`)
      }
      acceptingTranscriptsRef.current = false
      captureRef.current = null
      capture.stop()
      updateCaptureState('idle')
      // Mark idle before stopping the backend so its routine "stopped" events
      // cannot overwrite the actionable provider error in the Speech health chip.
      window.api.audioStop()
      setStatusBySource({
        interviewer: captureReason ? 'stopped' : `error: ${message}`,
        you: 'stopped'
      })
      return
    }

    const ready = captureOutcome.value
    setScreenReady(ready)
    screenReadyRef.current = ready
    if (screenEnabled && !ready) {
      setScreenError('System audio is active, but a screen frame could not be prepared.')
    }
    updateCaptureState('active')
    if (micEnabled) {
      const micStart = capture.startMic()
      micStartPromiseRef.current = micStart
      try {
        await micStart
        if (attempt !== captureAttemptRef.current) return
        window.api.audioSetMic(true)
      } catch (err) {
        if (attempt !== captureAttemptRef.current || (err as Error).name === 'AbortError') return
        setMicEnabled(false)
        const message = (err as Error).message
        setAudioError(`Mic: ${message}`)
        setStatusBySource((current) => ({ ...current, you: `error: ${message}` }))
      } finally {
        if (micStartPromiseRef.current === micStart) micStartPromiseRef.current = null
      }
    }
  }

  async function stopMicCaptureGracefully(capture: AudioCapture): Promise<void> {
    if (micStopPromiseRef.current) return micStopPromiseRef.current

    const operation = (async (): Promise<void> => {
      setStatusBySource((current) => ({ ...current, you: 'finalizing' }))
      try {
        await capture.flush('mic')
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setAudioError(`Mic: could not flush the local audio tail: ${(error as Error).message}`)
        }
      } finally {
        // Stop local PCM only after the worklet has emitted its partial buffer.
        capture.stop('mic')
      }

      const hadPendingTail = Boolean(
        interimRef.current.you.trim() ||
          finalsRef.current.some((line) => line.source === 'you' && line.provisional) ||
          vadRef.current.mic.lastVoiceTs > lastFinalTranscriptAtRef.current.mic
      )

      try {
        const result = await window.api.audioStopSourceGracefully('mic', 1800)
        if (result.timedOut && hadPendingTail) {
          setAudioError('Mic: finalization timed out; the last words were kept on a best-effort basis.')
        }
      } catch (error) {
        // Fall back to the immediate legacy stop if the graceful IPC itself fails.
        window.api.audioSetMic(false)
        setAudioError(`Mic: could not finalize speech: ${(error as Error).message}`)
      }

      const promoteTimer = promoteTimerRef.current.you
      if (promoteTimer) clearTimeout(promoteTimer)
      promoteTimerRef.current.you = null
      updateFinals((previous) =>
        sealTranscriptSourceForReconnect(previous, 'you', interimRef.current.you)
      )
      hasProvisionalRef.current.you = false
      updateInterim((previous) => ({ ...previous, you: '' }))
      setMicEnabled(false)
      setStatusBySource((current) => ({ ...current, you: 'stopped' }))
      captureAudioLevelStore.setLevel('mic', 0)
    })()
    micStopPromiseRef.current = operation
    try {
      await operation
    } finally {
      if (micStopPromiseRef.current === operation) micStopPromiseRef.current = null
    }
  }

  async function toggleMic(): Promise<void> {
    // Ignore another toggle until the browser has either attached or rejected the
    // pending microphone stream. This avoids turning off a half-created graph and
    // then reporting its expected AbortError as a real failure.
    if (micStartPromiseRef.current || micStopPromiseRef.current) return
    if (captureStateRef.current !== 'active') {
      setMicEnabled((value) => !value)
      return
    }

    const capture = captureRef.current
    if (!capture) return
    if (micEnabled) {
      await stopMicCaptureGracefully(capture)
      return
    }

    setAudioError(null)
    setMicEnabled(true)
    setStatusBySource((current) => ({ ...current, you: 'connecting' }))
    const micStart = capture.startMic()
    micStartPromiseRef.current = micStart
    try {
      await micStart
      window.api.audioSetMic(true)
    } catch (error) {
      if ((error as Error).name === 'AbortError' || captureStateRef.current !== 'active') return
      setMicEnabled(false)
      const message = error instanceof Error ? error.message : 'Microphone access failed.'
      setAudioError(`Mic: ${message}`)
      setStatusBySource((current) => ({ ...current, you: `error: ${message}` }))
    } finally {
      if (micStartPromiseRef.current === micStart) micStartPromiseRef.current = null
    }
  }

  function clearCaptureTimers(): void {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (maxWaitTimerRef.current) {
      clearTimeout(maxWaitTimerRef.current)
      maxWaitTimerRef.current = null
    }
    turnHasQuestionRef.current = false
    turnDirectedRef.current = false
  }

  function markTranscriptCorrected(lineCount: number, index: number, deleted: boolean): void {
    clearCaptureTimers()
    // A correction invalidates any transcript-derived rolling summary. Mark the
    // corrected snapshot consistently so future prompts/minutes read finalsRef.
    meetingSummaryRef.current = ''
    summarizedUptoRef.current = 0
    summarizeTargetRef.current = 0
    summaryAccRef.current = ''
    if (minutes) {
      setMinutesNotice('The transcript changed after this recap. Regenerate it to include corrections.')
    }
    const adjustHandledCount = (count: number): number =>
      Math.min(lineCount, Math.max(0, count - (deleted && index < count ? 1 : 0)))
    lastAnalyzedCountRef.current = adjustHandledCount(lastAnalyzedCountRef.current)
    lastAnsweredCountRef.current = adjustHandledCount(lastAnsweredCountRef.current)
  }

  function editFinalTranscriptLine(index: number, text: string): boolean {
    if (streamingRef.current || minutesGenerationActiveRef.current) {
      showAiNotice('Wait for the current AI response to finish before editing the transcript.')
      return false
    }
    const next = editTranscriptEntry(finalsRef.current, index, text)
    if (!next) return false
    updateFinals(next)
    markTranscriptCorrected(next.length, index, false)
    return true
  }

  function deleteFinalTranscriptLine(index: number): void {
    if (streamingRef.current || minutesGenerationActiveRef.current) {
      showAiNotice('Wait for the current AI response to finish before deleting transcript lines.')
      return
    }
    const next = deleteTranscriptEntry(finalsRef.current, index)
    if (!next) return
    updateFinals(next)
    markTranscriptCorrected(next.length, index, true)
  }

  function exportFinalTranscript(): boolean {
    const text = formatTranscriptExport(finalsRef.current, speakerNamesRef.current, isMeeting)
    if (!text) return false

    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = transcriptExportFilename(isMeeting)
      link.hidden = true
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      return true
    } catch {
      return false
    }
  }

  async function waitForTranscriptSettled(maxWaitMs = 1400, quietMs = 220): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      if (Date.now() - lastTranscriptEventAtRef.current >= quietMs) break
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }

  async function waitForCaptureIdle(maxWaitMs = 6000): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs
    while (captureStateRef.current === 'finalizing' && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
    return captureStateRef.current === 'idle'
  }

  async function pauseCapture(): Promise<void> {
    const pendingMicStop = micStopPromiseRef.current
    if (pendingMicStop) await pendingMicStop
    if (captureStateRef.current === 'idle' || captureStateRef.current === 'finalizing') return
    const wasStarting = captureStateRef.current === 'starting'
    const capture = captureRef.current
    captureAttemptRef.current += 1
    clearCaptureTimers()

    if (wasStarting) {
      acceptingTranscriptsRef.current = false
      captureRef.current = null
      capture?.stop()
      window.api.audioStop()
    } else {
      minutesTailNoticeRef.current = null
      if (!minutesGenerationActiveRef.current) setMinutesNotice(null)
      updateCaptureState('finalizing')
      let localFlushFailed = false
      try {
        if (capture) await capture.flush()
      } catch (error) {
        localFlushFailed = true
        setAudioError(`Could not flush the local audio tail: ${(error as Error).message}`)
      } finally {
        // Stop producing PCM before asking the provider to finalize. Otherwise
        // another segment can arrive after its flush marker and be dropped.
        captureRef.current = null
        capture?.stop()
      }
      // Flushing the worklet can emit its final sub-100 ms PCM chunk. Inspect VAD
      // only after that acknowledgement so a speech-only tail gets the full ASR
      // finalization window instead of the short quiet-stop path.
      const hadPendingTail = Boolean(
        interimRef.current.interviewer.trim() ||
          interimRef.current.you.trim() ||
          finalsRef.current.some((line) => line.provisional) ||
          vadRef.current.system.lastVoiceTs > lastFinalTranscriptAtRef.current.system ||
          vadRef.current.mic.lastVoiceTs > lastFinalTranscriptAtRef.current.mic
      )
      if (localFlushFailed && hadPendingTail) {
        const notice =
          'The local audio tail could not be fully flushed; pending words were included on a best-effort basis.'
        minutesTailNoticeRef.current = notice
        setMinutesNotice(notice)
      }
      try {
        // Sarvam emits final-only transcripts and loopback RMS can under-read, so
        // absence of an interim/VAD signal is not proof that there is no server
        // tail. Always allow the full bounded finalization window before closing.
        const result = await window.api.audioStopGracefully(1800)
        if (result.timedOut && hadPendingTail) {
          const notice =
            'ASR finalization timed out; the last interim words were included on a best-effort basis.'
          minutesTailNoticeRef.current = notice
          setMinutesNotice(notice)
        }
      } catch (error) {
        setAudioError(`Could not fully finalize audio: ${(error as Error).message}`)
        const notice =
          'The audio service could not confirm finalization; the last interim words were included on a best-effort basis.'
        minutesTailNoticeRef.current = notice
        setMinutesNotice(notice)
        window.api.audioStop()
      }
      await waitForTranscriptSettled()
      const committedAt = Date.now()
      const merged = mergeTranscriptForMinutes(finalsRef.current, interimRef.current).map((line) =>
        line.timestampMs == null ? { ...line, timestampMs: committedAt } : line
      )
      updateFinals(merged)
      updateInterim({ interviewer: '', you: '' })
      acceptingTranscriptsRef.current = false
    }

    updateCaptureState('idle')
    setScreenReady(false)
    screenReadyRef.current = false
    setScreenLikelyBlank(false)
    setStatusBySource({ interviewer: 'stopped', you: 'stopped' })
    captureAudioLevelStore.reset()
  }

  async function resetSession(): Promise<void> {
    if (captureStateRef.current !== 'idle') await pauseCapture()
    sessionGenerationRef.current += 1
    captureAttemptRef.current += 1
    acceptingTranscriptsRef.current = false
    lastTranscriptEventAtRef.current = 0
    lastFinalTranscriptAtRef.current = { system: 0, mic: 0 }
    clearCaptureTimers()
    const requestId = activeAiRequestIdRef.current
    if (requestId) window.api.aiCancel(requestId)
    activeAiRequestIdRef.current = null
    activeHandledRangeRef.current = null
    activeAiSessionRef.current = sessionGenerationRef.current
    clearWatchdog()
    streamingRef.current = false
    setStreaming(false)

    const clean = createSessionTrackingState()
    lastAnalyzedCountRef.current = clean.lastAnalyzedCount
    lastAnsweredCountRef.current = clean.lastAnsweredCount
    summarizedUptoRef.current = clean.summarizedUpto
    summarizeTargetRef.current = clean.summarizeTarget
    turnHasQuestionRef.current = clean.turnHasQuestion
    turnDirectedRef.current = clean.turnDirected
    queuedInterviewQuestionRef.current = clean.queuedInterviewQuestion
    meetingSummaryRef.current = clean.meetingSummary
    summaryAccRef.current = clean.summaryAccumulator
    answerAccRef.current = clean.answerAccumulator
    analysisAccRef.current = clean.analysisAccumulator
    consultantAccRef.current = clean.consultantAccumulator
    minutesAccRef.current = clean.minutesAccumulator
    minutesRunRef.current += 1
    minutesGenerationActiveRef.current = false
    minutesPreviousRef.current = ''
    minutesTailNoticeRef.current = null
    minutesPipelineRef.current = null
    historyRef.current = []
    pendingUserRef.current = null
    hasProvisionalRef.current = { interviewer: false, you: false }
    for (const source of ['interviewer', 'you'] as const) {
      const timer = promoteTimerRef.current[source]
      if (timer) clearTimeout(timer)
    }
    promoteTimerRef.current = { interviewer: null, you: null }

    updateFinals([])
    updateInterim({ interviewer: '', you: '' })
    setStatusBySource({ interviewer: '', you: '' })
    speakerNamesRef.current = {}
    setSpeakerNames({})
    setAnswerHistory([])
    setAnalysisHistory([])
    setConsultantHistory([])
    setSuggestion('')
    setAnalysis('')
    setConsultant('')
    setMinutes('')
    setMinutesOpen(false)
    setMinutesError(null)
    setMinutesNotice(null)
    setMinutesPreparing(false)
    setMinutesStage('idle')
    setMinutesCopied(false)
    setAiError(null)
    setAudioError(null)
    setManualQuestion('')
    setCurrentQuestion('')
    setCurrentAnswerStyle(answerStyleRef.current)
    setPinnedAnswers([])
    pinnedAnswerSequenceRef.current = 0
    setSeconds({ system: 0, mic: 0 })
    captureAudioLevelStore.reset()
    aiTokenBatcherRef.current?.clear()
    setLastScreenSentAt(null)
    setScreenReady(false)
    screenReadyRef.current = false
    setScreenError(null)
    setScreenLikelyBlank(false)
    setScreenPreview(null)
    intentRef.current = 'answer'
    setActiveIntent('answer')
    setActiveTab(isConsultant ? 'consultant' : isMeeting ? 'analysis' : 'answer')
  }

  const hasSessionContent = Boolean(
    captureState !== 'idle' ||
      finals.length ||
      interim.interviewer ||
      interim.you ||
      suggestion ||
      analysis ||
      consultant ||
      minutes
  )

  function requestSetup(): void {
    if (captureStateRef.current === 'idle' && !hasSessionContent) {
      onBack()
      return
    }
    setConfirmAction('setup')
  }

  async function performConfirmedAction(): Promise<void> {
    const action = confirmAction
    if (!action) return
    setConfirmBusy(true)
    try {
      if (action === 'new') {
        await resetSession()
      } else {
        if (captureStateRef.current !== 'idle') await pauseCapture()
        onBack()
      }
      setConfirmAction(null)
    } finally {
      setConfirmBusy(false)
    }
  }

  useEffect(() => {
    const off = window.api.onHotkey((payload) => {
      if (payload.action === 'ask') {
        if (finalsRef.current.length === 0 && screenReadyRef.current) analyzeScreen()
        else askAi(true)
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Title bar (draggable) */}
      <div className="drag flex shrink-0 items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            {capturing && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                capturing
                  ? 'bg-emerald-400'
                  : captureState === 'starting' || captureState === 'finalizing'
                    ? 'bg-amber-400'
                    : 'bg-zinc-500'
              }`}
            />
          </span>
          <span className="text-sm font-semibold text-zinc-100">
            {capturing
              ? 'Live'
              : captureState === 'starting'
                ? 'Starting'
                : captureState === 'finalizing'
                  ? 'Finalizing'
                  : 'Idle'}
          </span>
          {config?.role ? <span className="min-w-0 truncate text-xs text-zinc-500">· {config.role}</span> : null}
        </div>
        <div className="no-drag flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleStealth}
            aria-pressed={stealth}
            title={
              stealth
                ? 'Stealth ON — invisible to screenshots, recording & screen share. Click to show yourself.'
                : 'Stealth OFF — visible to screen share. Click to go invisible.'
            }
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
              stealth
                ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                : 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
            }`}
          >
            <EyeIcon off={stealth} />
            {stealth ? 'Protection on' : 'Protection off'}
          </button>
          <button
            type="button"
            onClick={() => updatePanels(toggleFocusMode(panels))}
            aria-pressed={focused}
            title={
              focused
                ? 'Show the status, controls and transcript panels again'
                : 'Focus mode — fold the status, controls and transcript away so the AI answer fills the window'
            }
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              focused
                ? 'bg-indigo-400/25 text-indigo-200 hover:bg-indigo-400/35'
                : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
            }`}
          >
            Focus
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={requestSetup}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Setup
          </button>
          <button
            type="button"
            onClick={() => window.api.hide()}
            title="Hide overlay — press Ctrl+Shift+Space (or click the tray dot) to bring it back"
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Hide
          </button>
        </div>
      </div>

      <SessionHealthBar
        captureState={captureState}
        systemStatus={statusBySource.interviewer}
        micStatus={statusBySource.you}
        speechConfigured={hasSpeechConfiguration(settingsStatus, provider)}
        micEnabled={micEnabled}
        screenEnabled={screenEnabled}
        screenReady={screenReady}
        screenError={screenError}
        screenLikelyBlank={screenLikelyBlank}
        aiConfigured={hasAiConfiguration(settingsStatus)}
        aiBusy={streaming}
        aiError={aiError}
        audioError={
          audioError &&
          (/^System audio:/i.test(audioError) ||
            /^Could not (?:flush the local audio tail|fully finalize audio)/i.test(audioError))
            ? audioError
            : null
        }
        collapsed={panels.health}
        onToggleCollapsed={() => collapsePanel('health')}
        onTestScreen={testScreenPreview}
      />

      <CaptureControls
        captureState={captureState}
        transcriptLineCount={finals.length}
        hasSessionContent={hasSessionContent}
        isMeeting={isMeeting}
        micEnabled={micEnabled}
        screenEnabled={screenEnabled}
        provider={provider}
        audioError={audioError}
        levelStore={captureAudioLevelStore}
        seconds={seconds}
        displaySources={displaySources}
        selectedDisplaySourceId={selectedDisplaySourceId}
        loadingDisplaySources={loadingDisplaySources}
        screenError={screenError}
        screenReady={screenReady}
        lastScreenSentAt={lastScreenSentAt}
        hasGeneratedSummary={Boolean(minutes)}
        generatingMinutes={minutesPreparing || minutesStage !== 'idle'}
        onStartOrPause={() => (captureBusy ? void pauseCapture() : void startCapture())}
        onNewSession={() => setConfirmAction('new')}
        onGenerateMinutes={() => {
          if (captureStateRef.current === 'idle' && minutes) setMinutesOpen(true)
          else void generateMinutes()
        }}
        onToggleMic={() => void toggleMic()}
        onToggleScreen={() => void toggleScreenContext()}
        onProviderChange={setProvider}
        onSelectDisplaySource={(id) => void changeDisplaySource(id)}
        onRefreshDisplaySources={() => void refreshDisplaySources()}
        collapsed={panels.controls}
        onToggleCollapsed={() => collapsePanel('controls')}
      />

      <TranscriptPanel
        lines={finals}
        interim={interim}
        meeting={isMeeting}
        speakerNames={speakerNames}
        captureState={captureState}
        onSpeakerNameChange={(speaker, name) => {
          const next = { ...speakerNamesRef.current, [speaker]: name }
          speakerNamesRef.current = next
          setSpeakerNames(next)
        }}
        onCopy={async () => {
          const text = formatTranscriptExport(
            finalsRef.current,
            speakerNamesRef.current,
            isMeeting
          )
          if (!text) return false
          try {
            return await window.api.copyText(text)
          } catch {
            try {
              await navigator.clipboard.writeText(text)
              return true
            } catch {
              return false
            }
          }
        }}
        onExport={exportFinalTranscript}
        onEditLine={editFinalTranscriptLine}
        onDeleteLine={deleteFinalTranscriptLine}
        mutationsDisabled={streaming}
        collapsed={panels.transcript}
        onToggleCollapsed={() => collapsePanel('transcript')}
      />

      {/* Manual question */}
      <div className="no-drag mx-3 mb-2 flex shrink-0 items-center gap-2">
        <label htmlFor="manual-question" className="sr-only">
          Question for the AI
        </label>
        <input
          id="manual-question"
          value={manualQuestion}
          onChange={(e) => setManualQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              askManual()
            }
          }}
          placeholder={
            isMeeting
              ? 'Ask for an answer or type a question to address…'
              : 'Type a question (scenario / long) and press Enter…'
          }
          className="flex-1 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-400/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={analyzeScreen}
          disabled={!screenReady || streaming}
          title="Analyze the current screen together with the recent transcript"
          className="rounded-md bg-cyan-500/20 px-2.5 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
        >
          See screen
        </button>
        <button
          type="button"
          onClick={askManual}
          disabled={streaming}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-400 disabled:opacity-40"
        >
          Ask
        </button>
      </div>

      <AiWorkspace
        meeting={isMeeting}
        activeTab={activeTab}
        activeIntent={activeIntent}
        streaming={streaming}
        screenReady={screenReady}
        autoAnalyze={autoAnalyze}
        autoAnswer={autoAnswer}
        error={aiError}
        notice={aiNotice}
        question={currentQuestion}
        answerHistory={answerHistory}
        answer={suggestion}
        analysisHistory={analysisHistory}
        analysis={analysis}
        consultantHistory={consultantHistory}
        consultant={consultant}
        onTabChange={setActiveTab}
        onToggleAutoAnalyze={() => setAutoAnalyze((value) => !value)}
        onToggleAutoAnswer={() => setAutoAnswer((value) => !value)}
        onCancel={cancelAi}
        onConsultScreen={consultScreen}
        onAnalyze={() => {
          setActiveTab('analysis')
          analyzeDiscussion(true)
        }}
        onAnswer={(style) => askAi(true, style ?? answerStyleRef.current)}
        onClearAnswers={clearAnswers}
        onClearAnalyses={clearAnalyses}
        onClearConsultant={clearConsultant}
        interviewControls={
          isMeeting
            ? undefined
            : {
                answerStyle,
                currentAnswerStyle,
                pinnedAnswers,
                onAnswerStyleChange: changeInterviewAnswerStyle,
                onRegenerateExactQuestion: regenerateInterviewAnswer,
                onPinnedAnswerChange: changePinnedInterviewAnswer
              }
        }
      />
      {/* Hotkey legend. Focus mode reclaims the row, but a shortcut that failed to
          register is actionable, so that warning survives. */}
      {(!focused || (shortcutHealth != null && !shortcutHealth.allRegistered)) && (
      <div className="drag flex shrink-0 items-center justify-between gap-2 border-t border-white/10 px-4 py-2 text-[10px] text-zinc-500">
        <div className="min-w-0 truncate">
          {!focused && (
            <>
              <span className="mr-3">Ctrl+Shift+Space show/hide</span>
              <span className="mr-3">Ctrl+Shift+Enter answer</span>
              <span className="mr-3">Ctrl+Shift+\ click-through</span>
              <span>Ctrl+Shift+H hide</span>
            </>
          )}
        </div>
        {shortcutHealth && (
          <div
            className="no-drag flex shrink-0 items-center gap-1"
            title={shortcutHealth.shortcuts
              .filter((shortcut) => !shortcut.registered)
              .map((shortcut) => `${shortcut.label} (${shortcut.accelerator}): ${shortcut.error ?? 'unavailable'}`)
              .join('\n')}
          >
            <span className={shortcutHealth.allRegistered ? 'text-emerald-300' : 'text-amber-300'}>
              {shortcutHealth.registered}/{shortcutHealth.total} shortcuts
            </span>
            {!shortcutHealth.allRegistered && (
              <button
                type="button"
                onClick={() => {
                  void window.api.retryShortcuts().then(setShortcutHealth).catch((error: unknown) => {
                    showAiNotice(error instanceof Error ? error.message : 'Shortcuts could not be retried.')
                  })
                }}
                className="rounded bg-amber-400/15 px-1.5 py-0.5 text-amber-200 hover:bg-amber-400/25"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
      )}

      <MinutesModal
        open={minutesOpen}
        kind={mode === 'interview' ? 'interview' : 'meeting'}
        minutes={minutes}
        error={minutesError}
        notice={minutesNotice}
        preparing={minutesPreparing}
        stage={minutesStage}
        generating={minutesPreparing || minutesStage !== 'idle'}
        copied={minutesCopied}
        canRegenerate={captureState === 'idle' && finals.length > 0}
        onCancel={cancelAi}
        onCopy={() => void copyMinutes()}
        onRegenerate={() => void generateMinutes()}
        onClose={() => setMinutesOpen(false)}
      />
      <ScreenPreviewModal preview={screenPreview} onClose={() => setScreenPreview(null)} />
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'new' ? 'Start a new session?' : 'Return to setup?'}
        description={
          confirmAction === 'new'
            ? 'Listening will stop safely, then the transcript, AI history, participant names and recap will be cleared.'
            : 'Listening will stop safely before leaving. The current transcript and AI results are not saved after you return to setup.'
        }
        confirmLabel={confirmAction === 'new' ? 'Clear and start new' : 'Stop and return'}
        danger
        busy={confirmBusy}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => void performConfirmedAction()}
      />
      {showSettings && (
        <SettingsPanel
          liveSession
          onSaved={() => void refreshSettingsStatus()}
          onClose={() => {
            setShowSettings(false)
            void refreshSettingsStatus()
          }}
        />
      )}
    </div>
  )
}
