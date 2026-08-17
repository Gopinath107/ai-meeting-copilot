import { useEffect, useRef, useState } from 'react'
import type { SessionConfig, SessionMode } from '../App'
import { AudioCapture, type AudioSourceKind } from '../audio/AudioCapture'
import type { AiIntent, AiTextMessage, ScreenshotContext } from '../../../shared/ai'
import type { DisplaySourceInfo } from '../../../shared/capture'
import {
  buildInterviewSystemPrompt as createInterviewSystemPrompt,
  buildMeetingSystemPrompt as createMeetingSystemPrompt,
  buildMinutesPrompt as createMinutesPrompt,
  buildSpeechKeyterms,
  buildSummarizerPrompt as createSummarizerPrompt
} from './overlay/prompts'
import {
  createSessionTrackingState,
  formatTranscript,
  mergeTranscriptForMinutes,
  shouldMarkAiRangeHandled,
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
  AiWorkspace,
  type AiWorkspaceIntent,
  type AiWorkspaceTab
} from './overlay/AiWorkspace'
import {
  createAiAskRequest,
  createAiRequestId,
  isDirectedAtMe,
  looksLikeQuestion
} from './overlay/aiOrchestration'

/**
 * Speech-to-text models (Sarvam/Whisper-style and Deepgram) hallucinate filler
 * during silence or background noise — classic phantoms are "you", "thank you",
 * "thanks for watching", "okay", or a single short token. Treat those as noise
 * so they never reach the transcript or fire a phantom auto-answer.
 */
const NOISE_PHRASES = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'subscribe',
  'bye',
  'okay',
  'ok',
  'mm',
  'mmm',
  'hmm',
  'mhm',
  'uh',
  'um',
  'ah',
  'oh',
  'yeah',
  'yep',
  'right',
  'so',
  'the',
  'a',
  'i'
])
// Common Whisper/Saaras hallucination sentences — subtitle and voiceover
// boilerplate the models emit over silence, music, or background noise.
const NOISE_PATTERNS: RegExp[] = [
  /^\[.*\]$/, // [music], [applause], [silence]
  /^\(.*\)$/, // (laughs), (music)
  /\bthanks?\s+(you\s+)?for\s+watching\b/,
  /\bplease\s+(like|subscribe|comment)\b/,
  /\bsubscribe\s+to\b/,
  /\bsee\s+you\s+(in\s+the\s+)?next\s+(video|time|one)\b/,
  /\bi'?ll\s+see\s+you\s+next\s+time\b/,
  /\bdon'?t\s+forget\s+to\s+subscribe\b/
]

function isNoise(raw: string): boolean {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?,…\-\s]+$/g, '')
    .trim()
  if (t.length === 0) return true
  if (NOISE_PHRASES.has(t)) return true
  // A lone, very short token with no spaces is almost always a misfire.
  if (!/\s/.test(t) && t.length <= 2) return true
  // The same short word repeated ("you you you", "so so so").
  const words = t.split(/\s+/)
  if (words.length >= 2 && words.every((w) => w === words[0]) && words[0].length <= 4) {
    return true
  }
  // Known subtitle/voiceover hallucination phrases.
  if (NOISE_PATTERNS.some((re) => re.test(t))) return true
  return false
}

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
  const [autoAnswer, setAutoAnswer] = useState(true)
  const [manualQuestion, setManualQuestion] = useState('')

  const captureRef = useRef<AudioCapture | null>(null)
  const [captureState, setCaptureState] = useState<CaptureDisplayState>('idle')
  const captureStateRef = useRef<CaptureDisplayState>('idle')
  const captureAttemptRef = useRef(0)
  const capturing = captureState === 'active'
  const captureBusy = captureState !== 'idle'

  function updateCaptureState(next: CaptureDisplayState): void {
    captureStateRef.current = next
    setCaptureState(next)
  }
  // Mic (your own voice) is off by default — we only need the interviewer
  // (system audio). The toggle stays for testing/diagnostics.
  const [micEnabled, setMicEnabled] = useState(false)
  const [stealth, setStealth] = useState(true)
  const [levels, setLevels] = useState<{ system: number; mic: number }>({ system: 0, mic: 0 })
  const [seconds, setSeconds] = useState<{ system: number; mic: number }>({ system: 0, mic: 0 })
  const [audioError, setAudioError] = useState<string | null>(null)
  // Screen-aware mode keeps the display video track locally and sends one
  // compressed frame only when an AI answer/analysis request is made.
  const [screenEnabled, setScreenEnabled] = useState(false)
  const [screenReady, setScreenReady] = useState(false)
  const [screenError, setScreenError] = useState<string | null>(null)
  const [lastScreenSentAt, setLastScreenSentAt] = useState<number | null>(null)
  const [displaySources, setDisplaySources] = useState<DisplaySourceInfo[]>([])
  const [selectedDisplaySourceId, setSelectedDisplaySourceId] = useState('')
  const selectedDisplaySourceIdRef = useRef('')
  const [loadingDisplaySources, setLoadingDisplaySources] = useState(false)
  const screenEnabledRef = useRef(screenEnabled)
  const screenReadyRef = useRef(screenReady)
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
  const [minutesCopied, setMinutesCopied] = useState(false)
  const minutesAccRef = useRef('')
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

  // Audio worklet level events can arrive rapidly. VAD still receives every
  // sample, while visual meters are updated at a bounded cadence.
  const pendingLevelsRef = useRef<{ system: number; mic: number }>({ system: 0, mic: 0 })
  const meterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    const finals = finalsRef.current
    const start = Math.min(lastAnsweredCountRef.current, finals.length)
    const turn: string[] = []
    // Walk back from the end, collecting the trailing run of interviewer lines,
    // but never earlier than the point we last answered.
    for (let i = finals.length - 1; i >= start; i--) {
      if (finals[i].source !== 'interviewer') break
      turn.unshift(finals[i].text)
    }
    // Fallback: if nothing new is attributable (e.g. everything got merged), use
    // the last interviewer line so we still answer something current.
    if (turn.length === 0) {
      for (let i = finals.length - 1; i >= 0; i--) {
        if (finals[i].source === 'interviewer') return finals[i].text.trim()
      }
    }
    return turn.join(' ').trim()
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
    if (streamingRef.current) return
    const from = summarizedUptoRef.current
    const to = finalsRef.current.length - SUMMARY_KEEP_RECENT
    if (to - from < SUMMARY_TRIGGER) return
    summarizeRange(from, to)
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
      activeAiRequestIdRef.current = null
      activeHandledRangeRef.current = null
      streamingRef.current = false
      setStreaming(false)
      if (intentRef.current === 'minutes') {
        setMinutesError('No response from the AI (timed out). Try generating minutes again.')
      } else if (intentRef.current !== 'summarize') {
        setAiError((prev) => prev ?? 'No response from the AI (timed out). Ask again.')
      }
      retryQueuedInterviewQuestion()
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
      setScreenError(null)
      setLastScreenSentAt(frame.capturedAt)
      return { ...frame, detail: 'high' }
    } catch (error) {
      setScreenReady(false)
      screenReadyRef.current = false
      setScreenError(
        `Could not capture the selected screen: ${(error as Error).message}. Sending transcript only.`
      )
      return undefined
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
    // Supersede any in-flight request so a new question is never blocked.
    if (streamingRef.current) {
      window.api.aiCancel(activeAiRequestIdRef.current ?? undefined)
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
    if (streamingRef.current) {
      window.api.aiCancel(activeAiRequestIdRef.current ?? undefined)
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
    if (streamingRef.current) window.api.aiCancel(activeAiRequestIdRef.current ?? undefined)
    intentRef.current = 'consultant'
    setActiveIntent('consultant')
    const prev = consultantAccRef.current.trim()
    if (prev) setConsultantHistory((h) => [...h, prev].slice(-30))
    setConsultant('')
    setAiError(null)
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
    if (finalsRef.current.length === 0) return
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

  function askAi(switchTab = false): void {
    if (finalsRef.current.length === 0) return
    const question = latestQuestion()
    if (!question) return
    // Only a manual Answer action moves you to the Answer tab; auto-answer leaves
    // your current tab alone.
    if (switchTab) setActiveTab('answer')
    const targetEnd = finalsRef.current.length
    if (isMeeting) {
      streamAnswer(
        `[ANSWER] Recent meeting discussion (context only — do NOT answer anything here):\n${transcriptWithHistory(14)}\n\n` +
          `THE QUESTION TO ANSWER NOW (the most recent thing directed at me):\n"${question}"\n\n` +
          `Answer ONLY this most recent question, in the first person, ready to say out loud. Ignore and do not re-answer any earlier questions — use the discussion above only as background if this question refers back to it.`,
        screenEnabledRef.current,
        { kind: 'answer', end: targetEnd }
      )
      return
    }
    streamAnswer(
      `Interview transcript (context only — do NOT answer anything here):\n${transcriptWithHistory(14)}\n\n` +
        `THE QUESTION TO ANSWER NOW (the interviewer's most recent question):\n"${question}"\n\n` +
      `Answer ONLY this most recent question thoroughly. Do not re-answer earlier questions; use the transcript above only as background if this question refers back to it.`,
      screenEnabledRef.current,
      { kind: 'answer', end: targetEnd }
    )
  }

  function retryQueuedInterviewQuestion(): void {
    if (isMeeting || !queuedInterviewQuestionRef.current) return
    setTimeout(() => {
      if (
        isMeeting ||
        streamingRef.current ||
        !autoAnswerRef.current ||
        finalsRef.current.length <= lastAnsweredCountRef.current
      ) {
        return
      }
      queuedInterviewQuestionRef.current = false
      askAi()
    }, 0)
  }

  function askManual(): void {
    const q = manualQuestion.trim()
    if (!q) return
    if (isConsultant) {
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
    streamAnswer(user, screenEnabledRef.current, { kind: 'answer', end: targetEnd })
    setManualQuestion('')
  }
  function clearConsultant(): void {
    setConsultantHistory([])
    setConsultant('')
    consultantAccRef.current = ''
  }

  function consultScreen(): void {
    if (!screenEnabledRef.current || !screenReadyRef.current) {
      setScreenError('Turn Screen on before listening, then start capture again.')
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
      setScreenError('Turn Screen on before listening, then start capture again.')
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
      streamAnswer(
        'Examine the attached current screen together with the recent interview transcript. Identify the visible question, code, diagram, error, or task and give me the concise, accurate response I should say or the solution I should explain.'
      )
    }
  }

  function cancelAi(): void {
    clearWatchdog()
    window.api.aiCancel(activeAiRequestIdRef.current ?? undefined)
    activeAiRequestIdRef.current = null
    activeHandledRangeRef.current = null
    setStreaming(false)
    streamingRef.current = false
    pendingUserRef.current = null
    queuedInterviewQuestionRef.current = false
  }

  // --- Minutes of Meeting ---------------------------------------------------
  // Called by the "End & Minutes" button. Stops capture, then asks the LLM to
  // turn the entire transcript (every finalised line) into minutes, streamed
  // into the minutes modal.
  async function generateMinutes(): Promise<void> {
    setMinutesError(null)
    setMinutesNotice(null)
    setMinutesOpen(true)
    if (captureStateRef.current !== 'idle') {
      setMinutesPreparing(true)
      await pauseCapture()
      setMinutesPreparing(false)
    }
    const snapshot = mergeTranscriptForMinutes(finalsRef.current, interimRef.current)
    if (snapshot.length === 0) {
      setMinutes('')
      setMinutesError('No transcript yet — start listening and capture the meeting first.')
      return
    }
    updateFinals(snapshot)
    updateInterim({ interviewer: '', you: '' })
    if (streamingRef.current) {
      window.api.aiCancel(activeAiRequestIdRef.current ?? undefined)
      activeHandledRangeRef.current = null
    }
    intentRef.current = 'minutes'
    setActiveIntent('minutes')
    minutesAccRef.current = ''
    setMinutes('')
    setStreaming(true)
    streamingRef.current = true
    pendingUserRef.current = null
    const full = formatTranscript(snapshot, speakerNamesRef.current, isMeeting)
    dispatchAiRequest('minutes', [
      { role: 'system', content: createMinutesPrompt(config) },
      {
        role: 'user',
        content: `Here is the full meeting transcript:\n\n${full}\n\nGenerate the Minutes of Meeting now, following the required format.`
      }
    ])
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
    const offToken = window.api.onAiToken(({ requestId, text }) => {
      if (activeAiRequestIdRef.current !== requestId) return
      armWatchdog(requestId)
      if (intentRef.current === 'summarize') {
        // Background memory update — accumulate silently, never touch the UI.
        summaryAccRef.current += text
      } else if (intentRef.current === 'minutes') {
        minutesAccRef.current += text
        setMinutes((prev) => prev + text)
      } else if (intentRef.current === 'analyze') {
        analysisAccRef.current += text
        setAnalysis((prev) => prev + text)
      } else if (intentRef.current === 'consultant') {
        consultantAccRef.current += text
        setConsultant((prev) => prev + text)
      } else {
        answerAccRef.current += text
        setSuggestion((prev) => prev + text)
      }
    })
    const offDone = window.api.onAiDone(({ requestId }) => {
      if (activeAiRequestIdRef.current !== requestId) return
      const handledRange = activeHandledRangeRef.current
      const output =
        intentRef.current === 'answer'
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
      // Only answers become conversation memory; analysis is stateless.
      if (intentRef.current === 'summarize') {
        const s = summaryAccRef.current.trim()
        if (s) {
          meetingSummaryRef.current = s
          summarizedUptoRef.current = summarizeTargetRef.current
        }
        summaryAccRef.current = ''
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
      activeAiRequestIdRef.current = null
      activeHandledRangeRef.current = null
      clearWatchdog()
      // A failed background summarise must stay silent — keep the old summary and
      // retry later rather than showing an error over the transcript.
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
        setMinutesError(message)
        setStreaming(false)
        streamingRef.current = false
        minutesAccRef.current = ''
        pendingUserRef.current = null
        return
      }
      setAiError(message)
      setStreaming(false)
      streamingRef.current = false
      pendingUserRef.current = null
      answerAccRef.current = ''
      analysisAccRef.current = ''
      consultantAccRef.current = ''
      retryQueuedInterviewQuestion()
    })
    return () => {
      offToken()
      offDone()
      offErr()
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
    if (looksLikeQuestion(last.text)) turnHasQuestionRef.current = true
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
      updateFinals((prev) => [...prev, { source: src, text: t, provisional: true }])
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
        const isBad = isNoise(text) || (conf !== undefined ? lowConfidence : !heardVoice)
        if (isBad) {
          if (!isNoise(text) && !heardVoice)
            console.debug('[vad] dropped silent hallucination:', text)
          if (!isNoise(text) && lowConfidence)
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
            next[idx] = { source, text, speaker, provisional: false }
            return next
          }
          return [...prev, { source, text, speaker }]
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
    const offS = window.api.onTranscriptStatus(({ source, status, message }) => {
      if (!acceptingTranscriptsRef.current && captureStateRef.current === 'idle') return
      setStatusBySource((previous) => ({
        ...previous,
        [source]: message ? `${status}: ${message}` : status
      }))
    })
    return () => {
      offT()
      offS()
      clearPromote('interviewer')
      clearPromote('you')
    }
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
      if (meterTimerRef.current) clearTimeout(meterTimerRef.current)
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
    pendingLevelsRef.current[kind] = level
    if (meterTimerRef.current) return
    meterTimerRef.current = setTimeout(() => {
      meterTimerRef.current = null
      setLevels({ ...pendingLevelsRef.current })
    }, 120)
  }

  async function startCapture(): Promise<void> {
    if (captureRef.current || captureStateRef.current !== 'idle') return
    const attempt = ++captureAttemptRef.current
    updateCaptureState('starting')
    setAudioError(null)
    setScreenError(null)
    setScreenReady(false)
    screenReadyRef.current = false
    setLastScreenSentAt(null)
    setStatusBySource({ interviewer: '', you: '' })
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
        setAudioError(`${kind}: ${err.message}`)
        if (captureRef.current === capture && kind === 'system' && /ended$/i.test(err.message)) {
          void pauseCapture()
        } else if (kind === 'mic' && /ended$/i.test(err.message)) {
          window.api.audioSetMic(false)
          setMicEnabled(false)
        }
      }
    })
    captureRef.current = capture
    window.api.audioStart(
      false,
      provider,
      buildSpeechKeyterms(config, { meeting: isMeeting, consultant: isConsultant })
    )
    try {
      const ready = await capture.startSystem(screenEnabled)
      if (attempt !== captureAttemptRef.current) {
        capture.stop()
        return
      }
      setScreenReady(ready)
      screenReadyRef.current = ready
      if (screenEnabled && !ready) {
        setScreenError('System audio is active, but a screen frame could not be prepared.')
      }
    } catch (err) {
      if (attempt !== captureAttemptRef.current || (err as Error).name === 'AbortError') return
      setAudioError(`System audio: ${(err as Error).message}`)
      if (screenEnabledRef.current) {
        setScreenError(
          `Screen capture failed: ${(err as Error).message}. Re-select the display; protected or DRM content may not be capturable.`
        )
      }
      capture.stop()
      captureRef.current = null
      acceptingTranscriptsRef.current = false
      window.api.audioStop()
      updateCaptureState('idle')
      return
    }
    updateCaptureState('active')
    if (micEnabled) {
      try {
        await capture.startMic()
        if (attempt !== captureAttemptRef.current) return
        window.api.audioSetMic(true)
      } catch (err) {
        if (attempt !== captureAttemptRef.current || (err as Error).name === 'AbortError') return
        window.api.audioSetMic(false)
        setMicEnabled(false)
        setAudioError(`Mic: ${(err as Error).message}`)
      }
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

  async function waitForTranscriptSettled(maxWaitMs = 1400, quietMs = 220): Promise<void> {
    const deadline = Date.now() + maxWaitMs
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      if (Date.now() - lastTranscriptEventAtRef.current >= quietMs) break
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }

  async function pauseCapture(): Promise<void> {
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
        setMinutesNotice(
          'The local audio tail could not be fully flushed; pending words were included on a best-effort basis.'
        )
      }
      try {
        const result = await window.api.audioStopGracefully(hadPendingTail ? 1800 : 400)
        if (result.timedOut && hadPendingTail) {
          setMinutesNotice('ASR finalization timed out; the last interim words were included on a best-effort basis.')
        }
      } catch (error) {
        setAudioError(`Could not fully finalize audio: ${(error as Error).message}`)
        setMinutesNotice('The audio service could not confirm finalization; the last interim words were included on a best-effort basis.')
        window.api.audioStop()
      }
      await waitForTranscriptSettled()
      const merged = mergeTranscriptForMinutes(finalsRef.current, interimRef.current)
      updateFinals(merged)
      updateInterim({ interviewer: '', you: '' })
      acceptingTranscriptsRef.current = false
    }

    updateCaptureState('idle')
    setScreenReady(false)
    screenReadyRef.current = false
    pendingLevelsRef.current = { system: 0, mic: 0 }
    setLevels({ system: 0, mic: 0 })
    if (meterTimerRef.current) {
      clearTimeout(meterTimerRef.current)
      meterTimerRef.current = null
    }
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
    setMinutesCopied(false)
    setAiError(null)
    setAudioError(null)
    setManualQuestion('')
    setSeconds({ system: 0, mic: 0 })
    setLevels({ system: 0, mic: 0 })
    setLastScreenSentAt(null)
    setScreenReady(false)
    screenReadyRef.current = false
    setScreenError(null)
    intentRef.current = 'answer'
    setActiveIntent('answer')
    setActiveTab(isConsultant ? 'consultant' : isMeeting ? 'analysis' : 'answer')
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
    <div className="flex h-full flex-col">
      {/* Title bar (draggable) */}
      <div className="drag flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-2">
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
          {config?.role ? <span className="text-xs text-zinc-500">· {config.role}</span> : null}
        </div>
        <div className="no-drag flex items-center gap-1">
          <button
            onClick={toggleStealth}
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
            {stealth ? 'Invisible' : 'Visible'}
          </button>
          <button
            onClick={onBack}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Setup
          </button>
          <button
            onClick={() => window.api.hide()}
            title="Hide overlay — press Ctrl+Shift+Space (or click the tray dot) to bring it back"
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            Hide
          </button>
        </div>
      </div>

      <CaptureControls
        captureState={captureState}
        transcriptLineCount={finals.length}
        hasSessionContent={Boolean(finals.length || suggestion || analysis || consultant)}
        isMeeting={isMeeting}
        micEnabled={micEnabled}
        screenEnabled={screenEnabled}
        provider={provider}
        audioError={audioError}
        levels={levels}
        seconds={seconds}
        displaySources={displaySources}
        selectedDisplaySourceId={selectedDisplaySourceId}
        loadingDisplaySources={loadingDisplaySources}
        screenError={screenError}
        screenReady={screenReady}
        lastScreenSentAt={lastScreenSentAt}
        generatingMinutes={streaming && activeIntent === 'minutes'}
        onStartOrPause={() => (captureBusy ? void pauseCapture() : void startCapture())}
        onNewSession={() => void resetSession()}
        onGenerateMinutes={() => void generateMinutes()}
        onToggleMic={() => setMicEnabled((value) => !value)}
        onToggleScreen={() => {
          const next = !screenEnabledRef.current
          screenEnabledRef.current = next
          setScreenEnabled(next)
          setScreenError(null)
          if (next) void refreshDisplaySources()
        }}
        onProviderChange={setProvider}
        onSelectDisplaySource={(id) => {
          selectedDisplaySourceIdRef.current = id
          setSelectedDisplaySourceId(id)
          setScreenError(null)
        }}
        onRefreshDisplaySources={() => void refreshDisplaySources()}
      />

      <TranscriptPanel
        lines={finals}
        interim={interim}
        meeting={isMeeting}
        speakerNames={speakerNames}
        statusBySource={statusBySource}
        captureState={captureState}
        onSpeakerNameChange={(speaker, name) => {
          const next = { ...speakerNamesRef.current, [speaker]: name }
          speakerNamesRef.current = next
          setSpeakerNames(next)
        }}
      />

      {/* Manual question */}
      <div className="no-drag mx-3 mb-2 flex items-center gap-2">
        <input
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
          onClick={analyzeScreen}
          disabled={!screenReady || streaming}
          title="Analyze the current screen together with the recent transcript"
          className="rounded-md bg-cyan-500/20 px-2.5 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
        >
          See screen
        </button>
        <button
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
        onAnswer={() => askAi(true)}
        onClearAnswers={clearAnswers}
        onClearAnalyses={clearAnalyses}
        onClearConsultant={clearConsultant}
      />
      {/* Hotkey legend */}
      <div className="drag border-t border-white/10 px-4 py-2 text-[10px] text-zinc-500">
        <span className="mr-3">Ctrl+Shift+Space show/hide</span>
        <span className="mr-3">Ctrl+Shift+Enter answer</span>
        <span className="mr-3">Ctrl+Shift+\ click-through</span>
        <span>Ctrl+Shift+H hide</span>
      </div>

      <MinutesModal
        open={minutesOpen}
        minutes={minutes}
        error={minutesError}
        notice={minutesNotice}
        preparing={minutesPreparing}
        generating={streaming && activeIntent === 'minutes'}
        copied={minutesCopied}
        canRegenerate={finals.length > 0}
        onCancel={cancelAi}
        onCopy={() => void copyMinutes()}
        onRegenerate={() => void generateMinutes()}
        onClose={() => setMinutesOpen(false)}
      />
    </div>
  )
}
